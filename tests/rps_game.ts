import * as anchor from "@coral-xyz/anchor";
import { RpsGame } from "../target/types/rps_game";
import { assert } from "chai";
import * as crypto from "crypto";

function hashMove(move: number, salt: string): Uint8Array {
  // Mirrors the Rust logic:
  //   hasher.update([move]);
  //   hasher.update(salt.as_bytes());
  const hasher = crypto.createHash("sha256");
  hasher.update(Buffer.from([move]));
  hasher.update(Buffer.from(salt, "utf8"));
  return new Uint8Array(hasher.digest()); // 32 bytes
}

describe("rps_game", () => {
  // Configure the client to use the local cluster.
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.RpsGame as anchor.Program<RpsGame>;
  const LAMPORTS = anchor.web3.LAMPORTS_PER_SOL;

  // ----------------------------------------------------------
  // 1) Simple "Is initialized!" test
  // ----------------------------------------------------------
  it("Is initialized!", async () => {
    const { SystemProgram } = anchor.web3;
    const hashedMove = new Uint8Array(32); // 32-byte array of zeros
    const gameAccount = anchor.web3.Keypair.generate();
    const wager = new anchor.BN(1 * LAMPORTS); // 1 SOL in lamports

    await program.rpc.createGame(
      hashedMove,
      wager,
      {
        accounts: {
          gameAccount: gameAccount.publicKey,
          creator: provider.wallet.publicKey,
          systemProgram: SystemProgram.programId, // Ensure naming matches
        },
        signers: [gameAccount],
      }
    );

    const gameAccountData = await program.account.gameState.fetch(gameAccount.publicKey);
    console.log("Initialized Game:", gameAccountData);
  });

  // ----------------------------------------------------------
  // 2) Join Game test
  // ----------------------------------------------------------
  it("Join Game test", async () => {
    const { SystemProgram } = anchor.web3;

    // Step 1: Create the game first
    const hashedMove = new Uint8Array(32); // Hashed move by the creator
    const gameAccount = anchor.web3.Keypair.generate();
    const wager = new anchor.BN(1 * LAMPORTS); // 1 SOL in lamports

    await program.rpc.createGame(
      hashedMove,
      wager,
      {
        accounts: {
          gameAccount: gameAccount.publicKey,
          creator: provider.wallet.publicKey,
          systemProgram: SystemProgram.programId, // Ensure naming matches
        },
        signers: [gameAccount],
      }
    );

    // Fetch the game account to ensure it was created
    const gameAccountData = await program.account.gameState.fetch(gameAccount.publicKey);
    console.log("Game Created:", gameAccountData);

    // Step 2: Join the game
    const joiner = anchor.web3.Keypair.generate(); // Simulate the joiner
    const joinerHashedMove = new Uint8Array(32); // Hashed move by the joiner

    // Airdrop SOL to the joiner for testing purposes
    const airdropSignature = await provider.connection.requestAirdrop(
      joiner.publicKey,
      2 * LAMPORTS // 2 SOL for testing
    );
    await provider.connection.confirmTransaction(airdropSignature);

    // Call the join_game instruction
    await program.rpc.joinGame(
      joinerHashedMove,
      {
        accounts: {
          gameAccount: gameAccount.publicKey,
          joiner: joiner.publicKey,
          systemProgram: SystemProgram.programId, // Ensure naming matches
        },
        signers: [joiner],
      }
    );

    // Fetch the updated game account and validate changes
    const updatedGameAccountData = await program.account.gameState.fetch(gameAccount.publicKey);
    console.log("Game Joined:", updatedGameAccountData);

    console.log("Game Status:", updatedGameAccountData.status);

    // Assertions to verify the game state after join
    assert.ok(updatedGameAccountData.opponent.equals(joiner.publicKey), "Opponent not set correctly");
    assert.deepEqual(
      Array.from(updatedGameAccountData.joinerMoveHashed),
      Array.from(joinerHashedMove),
      "Joiner's hashed move not stored properly"
    );
    assert.deepEqual(updatedGameAccountData.status, { committed: {} }, "Game status should be Committed");
  });

  // ----------------------------------------------------------
  // 3) Reveal Move test (end-to-end scenario)
  // ----------------------------------------------------------
  it("Reveal Move test (Creator wins Rock vs Scissors)", async () => {
    const { SystemProgram } = anchor.web3;

    console.log("setting up wallets")
    // 1) Set up three distinct wallets: Creator, Joiner, and House
    const creator = anchor.web3.Keypair.generate();
    const joiner = anchor.web3.Keypair.generate();
    const house = anchor.web3.Keypair.generate(); // House account

    // Airdrop SOL to creator, joiner, and house for testing
    const connection = provider.connection;

    console.log("airdropping sol")
    // Airdrop to Creator
    const creatorAirdropSig = await connection.requestAirdrop(
      creator.publicKey,
      3 * LAMPORTS // 3 SOL
    );
    await connection.confirmTransaction(creatorAirdropSig);

    // Airdrop to Joiner
    const joinerAirdropSig = await connection.requestAirdrop(
      joiner.publicKey,
      3 * LAMPORTS // 3 SOL
    );
    await connection.confirmTransaction(joinerAirdropSig);

    // Airdrop to House
    const houseAirdropSig = await connection.requestAirdrop(
      house.publicKey,
      1 * LAMPORTS // 1 SOL
    );
    await connection.confirmTransaction(houseAirdropSig);

    
    // Check initial balances
    const creatorInitialBal = await connection.getBalance(creator.publicKey);
    const joinerInitialBal = await connection.getBalance(joiner.publicKey);
    const houseInitialBal = await connection.getBalance(house.publicKey);
    console.log("Initial Balances:", creatorInitialBal, joinerInitialBal, houseInitialBal);


    // 2) Creator sets up the game with Rock
    const creatorMove = 0;  // Rock
    const creatorSalt = "creator_salt";
    const creatorHashedMove = hashMove(creatorMove, creatorSalt);
    console.log("Creator Hashed Move:", creatorHashedMove);

    const gameAccount = anchor.web3.Keypair.generate();
    const wagerBn = new anchor.BN(1 * LAMPORTS); // 1 SOL

    // Use a custom provider that signs as Creator
    const creatorProvider = new anchor.AnchorProvider(
      connection,
      new anchor.Wallet(creator),
      anchor.AnchorProvider.defaultOptions() // Use default options
    );
    
    const creatorProgram = new anchor.Program(program.idl, creatorProvider);
    console.log("made a creator program")

    await creatorProgram.rpc.createGame(
      creatorHashedMove,
      wagerBn,
      {
        accounts: {
          gameAccount: gameAccount.publicKey,
          creator: creator.publicKey,
          systemProgram: SystemProgram.programId, // Ensure naming matches
        },
        signers: [gameAccount, creator],
      }
    );
    console.log("created game")

    // 3) Joiner joins with Scissors
    const joinerMove = 2; // Scissors
    const joinerSalt = "joiner_salt";
    const joinerHashedMove = hashMove(joinerMove, joinerSalt);
    console.log("Joiner Hashed Move:", joinerHashedMove);

    // Use a custom provider that signs as Joiner
    const joinerProvider = new anchor.AnchorProvider(
      connection,
      new anchor.Wallet(joiner),
      {}
    );
    
    const joinerProgram = new anchor.Program(program.idl, joinerProvider);
    console.log("made a joiner program")

    await joinerProgram.rpc.joinGame(
      joinerHashedMove,
      {
        accounts: {
          gameAccount: gameAccount.publicKey,
          joiner: joiner.publicKey,
          systemProgram: SystemProgram.programId, // Ensure naming matches
        },
        signers: [joiner],
      }
    );
    console.log("joined game")

    // 4) Reveal moves
    // Use the creatorProgram to reveal as Creator
    await creatorProgram.rpc.revealMove(
      creatorMove,
      creatorSalt,
      {
        accounts: {
          gameAccount: gameAccount.publicKey,
          player: creator.publicKey,
          house: house.publicKey,      // Pass house account
          creator: creator.publicKey,  // Pass creator account
          joiner: joiner.publicKey,    // Pass joiner account
          systemProgram: SystemProgram.programId, // Ensure naming matches
        },
        signers: [creator],
      }
    );
    console.log("revealed creator move")

    // Use the joinerProgram to reveal as Joiner
    await joinerProgram.rpc.revealMove(
      joinerMove,
      joinerSalt,
      {
        accounts: {
          gameAccount: gameAccount.publicKey,
          player: joiner.publicKey,
          house: house.publicKey,      // Pass house account
          creator: creator.publicKey,  // Pass creator account
          joiner: joiner.publicKey,    // Pass joiner account
          systemProgram: SystemProgram.programId, // Ensure naming matches
        },
        signers: [joiner],
      }
    );
    console.log("revealed joiner move")

    // Game should be ended now
    const finalGameData = await creatorProgram.account.gameState.fetch(gameAccount.publicKey);
    console.log("Final Game Data:", finalGameData);
    assert.deepEqual(finalGameData.status, { ended: {} }, "Game should be Ended");

    // 5) Check final balances
    const creatorFinalBal = await connection.getBalance(creator.publicKey);
    const joinerFinalBal = await connection.getBalance(joiner.publicKey);
    const houseFinalBal = await connection.getBalance(house.publicKey);

    // Pot = 2 SOL, house fee = 0.06 SOL, winner = 1.94 SOL
    // Because each transaction has fees, we'll check ranges
    const expectedHouseFee = 6 * LAMPORTS / 100; // 3% of 2 SOL = 0.06 SOL

    // Calculate net gains
    const netCreatorGain = creatorFinalBal - creatorInitialBal;
    const netJoinerLoss = joinerInitialBal - joinerFinalBal;
    const netHouseGain = houseFinalBal - houseInitialBal;

    // Assertions
    // Creator should gain approximately 1.94 SOL (minus tx fees)
    assert.ok(
      netCreatorGain > 1.8 * LAMPORTS,
      `Creator should have gained at least 1.8 SOL. Actual: ${netCreatorGain / LAMPORTS} SOL`
    );

    // Joiner should lose approximately 1 SOL (plus tx fees)
    assert.ok(
      netJoinerLoss > 0.99 * LAMPORTS,
      `Joiner should have lost at least 0.99 SOL. Actual loss: ${netJoinerLoss / LAMPORTS} SOL`
    );

    // House should have gained approximately 0.06 SOL
    assert.ok(
      netHouseGain >= expectedHouseFee && netHouseGain <= expectedHouseFee + 1 * LAMPORTS,
      `House should have gained around 0.06 SOL. Actual gain: ${netHouseGain / LAMPORTS} SOL`
    );

    console.log("Creator initial:", creatorInitialBal / LAMPORTS, "SOL");
    console.log("Creator final:", creatorFinalBal / LAMPORTS, "SOL");
    console.log("Joiner initial:", joinerInitialBal / LAMPORTS, "SOL");
    console.log("Joiner final:", joinerFinalBal / LAMPORTS, "SOL");
    console.log("House initial:", houseInitialBal / LAMPORTS, "SOL");
    console.log("House final:", houseFinalBal / LAMPORTS, "SOL");
    console.log("Reveal Move test complete (Creator wins).");
  });
});