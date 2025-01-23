// Import dependencies
use anchor_lang::prelude::*;

// Declare the program ID
declare_id!("28AfQg9jGzkW9tJw9zQ857ncvuUnnNHE4vGb4pLpPLRM");

// Define the program module
#[program]
pub mod rps_game {
    use super::*;

    // Instruction: Create a new game
    pub fn create_game(
        ctx: Context<CreateGame>,
        creator_move_hashed: [u8; 32], // Hashed move from the creator
        wager: u64,                    // Wager amount
    ) -> Result<()> {
        let game_account = &mut ctx.accounts.game_account;

        // Initialize game account fields
        game_account.creator = *ctx.accounts.creator.key; // Assign creator's public key
        game_account.opponent = None;                     // No opponent yet
        game_account.creator_move_hashed = creator_move_hashed; // Store hashed move
        game_account.joiner_move_hashed = [0u8; 32];      // Default empty hash for joiner
        game_account.wager = wager;                       // Set wager
        game_account.status = GameStatus::Open;           // Set status to Open

        // TODO: Add logic for transferring SOL to escrow (if required)
        Ok(())
    }
}

// Define the GameState struct
#[account]
pub struct GameState {
    pub creator: Pubkey,             // Creator's public key
    pub opponent: Option<Pubkey>,    // Opponent's public key (optional)
    pub creator_move_hashed: [u8; 32], // Creator's hashed move
    pub joiner_move_hashed: [u8; 32],  // Joiner's hashed move (initially zeroed out)
    pub wager: u64,                  // Wager amount in SOL
    pub status: GameStatus,          // Current status of the game
}

// Define the GameStatus enum
#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq)]
pub enum GameStatus {
    Open,        // Game is open and waiting for an opponent
    Committed,   // Both players have committed their moves
    Ended,       // Game has ended
}

// Compute MAX_SIZE for the GameState account
impl GameState {
    pub const MAX_SIZE: usize = 32  // Pubkey (creator)
        + 1 + 32                    // Option<Pubkey> (opponent)
        + 32                        // creator_move_hashed
        + 32                        // joiner_move_hashed
        + 8                         // wager (u64)
        + 1;                        // status (GameStatus, single byte)
}

// Context for the create_game instruction
#[derive(Accounts)]
#[instruction(creator_move_hashed: [u8; 32], wager: u64)]
pub struct CreateGame<'info> {
    #[account(init, payer = creator, space = 8 + GameState::MAX_SIZE)] // Allocate GameState account
    pub game_account: Account<'info, GameState>,
    #[account(mut)] // Creator's wallet, must sign and pay for account creation
    pub creator: Signer<'info>,
    /// System program for account initialization and SOL transfers
    pub system_program: Program<'info, System>,
}

