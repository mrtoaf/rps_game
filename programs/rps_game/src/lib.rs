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
        wager: u64,                    // Wager amount (in lamports)
    ) -> Result<()> {
        let game_account = &mut ctx.accounts.game_account;

        // Initialize game account fields
        game_account.creator = *ctx.accounts.creator.key;
        game_account.opponent = None;
        game_account.creator_move_hashed = [0u8; 32];
        game_account.joiner_move_hashed = [0u8; 32];
        game_account.creator_ready = false;
        game_account.joiner_ready = false;
        game_account.wager = wager;
        game_account.status = GameStatus::Open;
        game_account.bump = ctx.bumps.game_account;

        // Transfer wager lamports from creator to game_account
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
    ) -> Result<()> {
        let game_account = &mut ctx.accounts.game_account;

        require!(
            game_account.status == GameStatus::Open,
            ErrorCode::GameNotOpen
        );

        game_account.opponent = Some(*ctx.accounts.joiner.key);
        game_account.status = GameStatus::Committed;

        // Transfer wager lamports from joiner to game_account
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
    // Instruction: Select a move
    // ------------------------------------
    pub fn select_move(
        ctx: Context<SelectMove>,
        original_move: u8, // 0=Rock, 1=Paper, 2=Scissors
        salt: String,
    ) -> Result<()> {
        let game_account = &mut ctx.accounts.game_account;
        let player_key = ctx.accounts.player.key();

        // Hash the move with the salt
        let mut hasher = Sha256::new();
        hasher.update([original_move]);
        hasher.update(salt.as_bytes());
        let result = hasher.finalize();
        let mut hashed_move = [0u8; 32];
        hashed_move.copy_from_slice(&result[..32]);

        // Update the appropriate player's hashed move
        if player_key == game_account.creator {
            game_account.creator_move_hashed = hashed_move;
        } else if Some(player_key) == game_account.opponent {
            game_account.joiner_move_hashed = hashed_move;
        } else {
            return err!(ErrorCode::Unauthorized);
        }

        Ok(())
    }

    // ------------------------------------
    // Instruction: Ready up
    // ------------------------------------
    pub fn ready_up(ctx: Context<ReadyUp>) -> Result<()> {
        let game_account = &mut ctx.accounts.game_account;
        let player_key = ctx.accounts.player.key();
        
        if player_key != game_account.creator && Some(player_key) != game_account.opponent {
            return err!(ErrorCode::Unauthorized);
        }
        
        // Prevent ready_up if the game has already ended
        match game_account.status {
            GameStatus::Ended => return err!(ErrorCode::GameAlreadyEnded),
            _ => {}
        }
        
        // Check if the player has selected a move
        if player_key == game_account.creator {
            require!(
                game_account.creator_move_hashed != [0u8; 32],
                ErrorCode::MoveNotSelected
            );
            game_account.creator_ready = true;
        } else if Some(player_key) == game_account.opponent {
            require!(
                game_account.joiner_move_hashed != [0u8; 32],
                ErrorCode::MoveNotSelected
            );
            game_account.joiner_ready = true;
        } else {
            return err!(ErrorCode::Unauthorized);
        }
    
        // Check if both players are ready
        if game_account.creator_ready && game_account.joiner_ready {
            // Both players are ready; determine the winner
            let winner = decide_winner(
                game_account.creator_move_hashed,
                game_account.joiner_move_hashed,
            )?;
            handle_payout(winner, game_account)?;
            game_account.status = GameStatus::Ended;
        }
    
        Ok(())
    }
}

// ------------------------------------
// Helper Functions
// ------------------------------------
fn decide_winner(creator_move_hashed: [u8; 32], joiner_move_hashed: [u8; 32]) -> Result<RPSResult> {
    match (creator_move_hashed[0] % 3, joiner_move_hashed[0] % 3) {
        (x, y) if x == y => Ok(RPSResult::Tie),
        (0, 2) | (1, 0) | (2, 1) => Ok(RPSResult::CreatorWins),
        _ => Ok(RPSResult::JoinerWins),
    }
}

fn handle_payout(winner: RPSResult, game_account: &mut Account<GameState>) -> Result<()> {
    match winner {
        RPSResult::CreatorWins => msg!("Creator wins!"),
        RPSResult::JoinerWins => msg!("Joiner wins!"),
        RPSResult::Tie => msg!("It's a tie!"),
    }
    Ok(())
}

// ------------------------------------
// Data Structures
// ------------------------------------

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq, Debug)]
pub enum GameStatus {
    Open,
    Committed,
    Ended,
}

#[derive(Debug)]
pub enum RPSResult {
    CreatorWins,
    JoinerWins,
    Tie,
}

#[account]
#[derive(Debug)]
pub struct GameState {
    pub creator: Pubkey,
    pub opponent: Option<Pubkey>,
    pub creator_move_hashed: [u8; 32],
    pub joiner_move_hashed: [u8; 32],
    pub creator_ready: bool,
    pub joiner_ready: bool,
    pub wager: u64,
    pub status: GameStatus,
    pub bump: u8,
}

impl GameState {
    pub const MAX_SIZE: usize = 32 // creator pubkey
        + 1 + 32 // optional opponent pubkey
        + 32 // creator_move_hashed
        + 32 // joiner_move_hashed
        + 1 // creator_ready
        + 1 // joiner_ready
        + 8 // wager
        + 1 // status
        + 1; // bump
}

#[derive(Accounts)]
#[instruction(wager: u64)]
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
pub struct SelectMove<'info> {
    #[account(mut)]
    pub game_account: Account<'info, GameState>,

    #[account(mut)]
    pub player: Signer<'info>,
}

#[derive(Accounts)]
pub struct ReadyUp<'info> {
    #[account(mut)]
    pub game_account: Account<'info, GameState>,

    #[account(mut)]
    pub player: Signer<'info>,
}

#[error_code]
pub enum ErrorCode {
    #[msg("The game is not open for joining.")]
    GameNotOpen,

    #[msg("The player has not selected a move.")]
    MoveNotSelected,

    #[msg("Unauthorized action.")]
    Unauthorized,

    #[msg("Game has already ended.")]
    GameAlreadyEnded,
}
