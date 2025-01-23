// Import dependencies
use anchor_lang::prelude::*;
use anchor_lang::solana_program::{program::invoke, program::invoke_signed, system_instruction};
use sha2::{Digest, Sha256};

// ------------------------------------
// Declare the program ID
// ------------------------------------
declare_id!("28AfQg9jGzkW9tJw9zQ857ncvuUnnNHE4vGb4pLpPLRM");

// ------------------------------------
// Constants
// ------------------------------------
const GAME_SEED: &[u8] = b"game";

// ------------------------------------
// The Program Module
// ------------------------------------
#[program]
pub mod rps_game {
    use super::*;

    // ------------------------------------
    // Instruction: Create a new game
    // ------------------------------------
    pub fn create_game(
        ctx: Context<CreateGame>,
        creator_move_hashed: [u8; 32], // Hashed move from the creator
        wager: u64,                    // Wager amount (in lamports)
    ) -> Result<()> {
        let game_account = &mut ctx.accounts.game_account;

        // Initialize game account fields
        game_account.creator = *ctx.accounts.creator.key;
        game_account.opponent = None;
        game_account.creator_move_hashed = creator_move_hashed;
        game_account.joiner_move_hashed = [0u8; 32];
        game_account.creator_move_revealed = None;
        game_account.joiner_move_revealed = None;
        game_account.wager = wager;
        game_account.status = GameStatus::Open;
        game_account.bump = ctx.bumps.game_account; // Corrected bump access

        // -----------------------------------
        // Transfer SOL = 'wager' lamports
        // from the creator to the game_account
        // -----------------------------------
        if wager > 0 {
            let ix = system_instruction::transfer(
                &ctx.accounts.creator.key(),
                &ctx.accounts.game_account.key(),
                wager,
            );
            invoke(
                &ix,
                &[
                    ctx.accounts.creator.to_account_info(),
                    ctx.accounts.game_account.to_account_info(),
                    ctx.accounts.system_program.to_account_info(),
                ],
            )?;
        }

        Ok(())
    }

    // ------------------------------------
    // Instruction: Join an existing game
    // ------------------------------------
    pub fn join_game(
        ctx: Context<JoinGame>,
        joiner_move_hashed: [u8; 32],
    ) -> Result<()> {
        let game_account = &mut ctx.accounts.game_account;

        require!(
            game_account.status == GameStatus::Open,
            ErrorCode::GameNotOpen
        );

        game_account.opponent = Some(*ctx.accounts.joiner.key);
        game_account.joiner_move_hashed = joiner_move_hashed;
        game_account.status = GameStatus::Committed;

        // -----------------------------------
        // Transfer the same 'wager' lamports
        // from the joiner to the game_account
        // -----------------------------------
        let wager = game_account.wager;
        if wager > 0 {
            let ix = system_instruction::transfer(
                &ctx.accounts.joiner.key(),
                &ctx.accounts.game_account.key(),
                wager,
            );
            invoke(
                &ix,
                &[
                    ctx.accounts.joiner.to_account_info(),
                    ctx.accounts.game_account.to_account_info(),
                    ctx.accounts.system_program.to_account_info(),
                ],
            )?;
        }

        Ok(())
    }

    // ------------------------------------
    // Instruction: Reveal your move
    // ------------------------------------
    pub fn reveal_move(
        ctx: Context<RevealMove>,
        original_move: u8, // 0=Rock,1=Paper,2=Scissors
        salt: String,
    ) -> Result<()> {
        // Step 1: Extract immutable data first
        let game_account_key = ctx.accounts.game_account.key(); // Corrected method call
        let game_account_info = ctx.accounts.game_account.to_account_info();

        // Clone AccountInfos to use later without borrow conflicts
        let house_info = ctx.accounts.house.to_account_info();
        let creator_info = ctx.accounts.creator.to_account_info();
        let joiner_info = ctx.accounts.joiner.to_account_info();
        let system_program_info = ctx.accounts.system_program.to_account_info();

        // Step 2: Create a mutable reference to game_account
        let game_account = &mut ctx.accounts.game_account;

        msg!("Game Account Before Mutation: {:?}", game_account);

        require!(
            matches!(game_account.status, GameStatus::Committed),
            ErrorCode::InvalidGameStatus
        );

        let player_key = ctx.accounts.player.key();

        // Recompute hash from (original_move, salt)
        let mut hasher = Sha256::new();
        hasher.update([original_move]);
        hasher.update(salt.as_bytes());
        let result = hasher.finalize();
        let mut computed_hash = [0u8; 32];
        computed_hash.copy_from_slice(&result[..32]);

        // Check if caller is creator or opponent, compare with stored hash
        if player_key == game_account.creator {
            require!(
                game_account.creator_move_hashed == computed_hash,
                ErrorCode::InvalidReveal
            );
            // Store the revealed move
            game_account.creator_move_revealed = Some(original_move);
        } else if Some(player_key) == game_account.opponent {
            require!(
                game_account.joiner_move_hashed == computed_hash,
                ErrorCode::InvalidReveal
            );
            game_account.joiner_move_revealed = Some(original_move);
        } else {
            return err!(ErrorCode::Unauthorized);
        }

        // Check if both players have revealed
        if let (Some(creator_move), Some(joiner_move)) = (
            game_account.creator_move_revealed,
            game_account.joiner_move_revealed,
        ) {
            // Decide winner
            let rps_result = decide_winner(creator_move, joiner_move);

            // The total pot = 2 * wager (assuming both put in the same amount)
            let total_pot = 2u64
                .checked_mul(game_account.wager)
                .ok_or(ErrorCode::NumericalOverflow)?;

            // 3% house fee
            let house_fee_u128 = (total_pot as u128)
                .checked_mul(3)
                .ok_or(ErrorCode::NumericalOverflow)?
                / 100; // 3%
            let house_fee: u64 = house_fee_u128
                .try_into()
                .map_err(|_| ErrorCode::NumericalOverflow)?;

            let payout = total_pot
                .checked_sub(house_fee)
                .ok_or(ErrorCode::NumericalOverflow)?;

            // --------------
            // Transfer logic
            // --------------
            // Define seeds and bump for PDA signing
            let seeds = &[
                GAME_SEED,
                game_account.creator.as_ref(),
                &game_account.wager.to_le_bytes(),
                &[game_account.bump],
            ];
            let signer_seeds = &[&seeds[..]];

            // Transfer house fee
            if house_fee > 0 {
                let ix = system_instruction::transfer(
                    &game_account_key,
                    &house_info.key(),
                    house_fee,
                );
                invoke_signed(
                    &ix,
                    &[
                        game_account_info.clone(),
                        house_info.clone(),
                        system_program_info.clone(),
                    ],
                    signer_seeds,
                )?;
            }

            // Transfer the remainder to the winner(s) or split if tie
            match rps_result {
                RPSResult::CreatorWins => {
                    let ix = system_instruction::transfer(
                        &game_account_key,
                        &creator_info.key(),
                        payout,
                    );
                    invoke_signed(
                        &ix,
                        &[
                            game_account_info.clone(),
                            creator_info.clone(),
                            system_program_info.clone(),
                        ],
                        signer_seeds,
                    )?;
                }
                RPSResult::JoinerWins => {
                    let ix = system_instruction::transfer(
                        &game_account_key,
                        &joiner_info.key(),
                        payout,
                    );
                    invoke_signed(
                        &ix,
                        &[
                            game_account_info.clone(),
                            joiner_info.clone(),
                            system_program_info.clone(),
                        ],
                        signer_seeds,
                    )?;
                }
                RPSResult::Tie => {
                    // If it's a tie, each gets half of 'payout'
                    let half_payout = payout / 2;

                    let ix_creator = system_instruction::transfer(
                        &game_account_key,
                        &creator_info.key(),
                        half_payout,
                    );
                    let ix_joiner = system_instruction::transfer(
                        &game_account_key,
                        &joiner_info.key(),
                        half_payout,
                    );

                    invoke_signed(
                        &ix_creator,
                        &[
                            game_account_info.clone(),
                            creator_info.clone(),
                            system_program_info.clone(),
                        ],
                        signer_seeds,
                    )?;
                    invoke_signed(
                        &ix_joiner,
                        &[
                            game_account_info.clone(),
                            joiner_info.clone(),
                            system_program_info.clone(),
                        ],
                        signer_seeds,
                    )?;
                }
            }

            // Mark the game as ended
            game_account.status = GameStatus::Ended;
        }

        msg!("Game Account After Mutation: {:?}", game_account);
        Ok(())
    }
}

// ------------------------------------
// Data Structures
// ------------------------------------
#[account]
#[derive(Debug)]
pub struct GameState {
    pub creator: Pubkey,                 // Creator's public key
    pub opponent: Option<Pubkey>,        // Opponent's public key (optional)

    // Commitments
    pub creator_move_hashed: [u8; 32],   // Creator's hashed move
    pub joiner_move_hashed: [u8; 32],    // Joiner's hashed move

    // Revealed moves if any (None if not revealed)
    // 0=Rock, 1=Paper, 2=Scissors
    pub creator_move_revealed: Option<u8>,
    pub joiner_move_revealed: Option<u8>,

    pub wager: u64,                      // Wager amount in lamports
    pub status: GameStatus,              // Current status of the game
    pub bump: u8,                        // Bump for PDA
}

// GameStatus enum
#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq, Debug)]
pub enum GameStatus {
    Open,      // Game is open and waiting
    Committed, // Both players have hashed their moves
    Ended,     // Game has ended
}

impl GameState {
    pub const MAX_SIZE: usize =
        32 +            // creator
        1 + 32 +        // opponent (Option<Pubkey>)
        32 +            // creator_move_hashed
        32 +            // joiner_move_hashed
        2 +             // creator_move_revealed (Option<u8>)
        2 +             // joiner_move_revealed (Option<u8>)
        8 +             // wager
        1 +             // status
        1;              // bump
}

// ------------------------------------
// Contexts
// ------------------------------------
#[derive(Accounts)]
#[instruction(creator_move_hashed: [u8; 32], wager: u64)]
pub struct CreateGame<'info> {
    #[account(
        init,
        payer = creator,
        seeds = [GAME_SEED, creator.key().as_ref(), &wager.to_le_bytes()],
        bump,
        space = 8 + GameState::MAX_SIZE
    )]
    pub game_account: Account<'info, GameState>,

    #[account(mut)]
    pub creator: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct JoinGame<'info> {
    #[account(mut)]
    pub game_account: Account<'info, GameState>,

    #[account(mut)]
    pub joiner: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RevealMove<'info> {
    #[account(
        mut,
        seeds = [GAME_SEED, creator.key().as_ref(), &game_account.wager.to_le_bytes()],
        bump = game_account.bump
    )]
    pub game_account: Account<'info, GameState>,

    #[account(mut)]
    pub player: Signer<'info>,

    /// The house wallet that receives 3% fee
    /// CHECK: We don't verify anything about this account
    #[account(mut)]
    pub house: UncheckedAccount<'info>,

    /// The creator of the game
    /// CHECK
    pub creator: AccountInfo<'info>,

    /// The joiner of the game
    /// CHECK
    pub joiner: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

// ------------------------------------
// Error Codes
// ------------------------------------
#[error_code]
pub enum ErrorCode {
    #[msg("The game is not open for joining.")]
    GameNotOpen,

    #[msg("Invalid reveal: The move/salt doesn't match your committed hash.")]
    InvalidReveal,

    #[msg("You are not authorized to reveal in this game.")]
    Unauthorized,

    #[msg("Current game status does not allow this action.")]
    InvalidGameStatus,

    #[msg("Overflow in arithmetic.")]
    NumericalOverflow,
}

// ------------------------------------
// Additional RPS Helpers
// ------------------------------------

// No need for HOUSE_PUBKEY constant anymore

/// A small enum to track RPS outcomes
#[derive(Debug)]
pub enum RPSResult {
    CreatorWins,
    JoinerWins,
    Tie,
}

/// Decide the winner of RPS
fn decide_winner(creator_move: u8, joiner_move: u8) -> RPSResult {
    // 0=Rock,1=Paper,2=Scissors
    if creator_move == joiner_move {
        return RPSResult::Tie;
    }
    match (creator_move, joiner_move) {
        (0, 2) => RPSResult::CreatorWins, // Rock > Scissors
        (1, 0) => RPSResult::CreatorWins, // Paper > Rock
        (2, 1) => RPSResult::CreatorWins, // Scissors > Paper
        _ => RPSResult::JoinerWins,
    }
}