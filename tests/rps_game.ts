// tests/rps_game.test.ts

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { RpsGame } from "../target/types/rps_game"; // Ensure this path is correct
import { assert } from "chai";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { BN } from "bn.js";
import * as crypto from "crypto"; // Import crypto for hashing

describe("rps_game - Create, Join, Select Move, and Ready Up", () => {
  // Configure the client to use the local cluster.
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.RpsGame as Program<RpsGame>;

  // Define keypairs
  const creator = Keypair.generate();
  const joiner = Keypair.generate();
  const house = Keypair.generate(); // House account can be a Keypair or a predefined account

  // Helper function to derive PDA
  const findGameAccountPda = async (
    creator: Keypair,
    wager: number,
    programId: PublicKey
  ): Promise<[PublicKey, number]> => {
    const wagerBn = new BN(wager);
    const wagerBuffer = wagerBn.toArrayLike(Buffer, "le", 8); // 8-byte little-endian

    return PublicKey.findProgramAddress(
      [Buffer.from("game"), creator.publicKey.toBuffer(), wagerBuffer],
      programId
    );
  };

  // Helper function to compute SHA-256 hash
  const hashMove = (original_move: number, salt: string): Buffer => {
    const hash = crypto.createHash("sha256");
    hash.update(Buffer.from([original_move]));
    hash.update(Buffer.from(salt));
    return hash.digest();
  };

  before(async () => {
    // Airdrop SOL to creator, joiner, and house for tests
    const airdropAmountCreator = 2 * anchor.web3.LAMPORTS_PER_SOL;
    const airdropSignatureCreator = await provider.connection.requestAirdrop(
      creator.publicKey,
      airdropAmountCreator
    );
    await provider.connection.confirmTransaction(airdropSignatureCreator, "confirmed");

    const airdropAmountJoiner = 2 * anchor.web3.LAMPORTS_PER_SOL;
    const airdropSignatureJoiner = await provider.connection.requestAirdrop(
      joiner.publicKey,
      airdropAmountJoiner
    );
    await provider.connection.confirmTransaction(airdropSignatureJoiner, "confirmed");

    const airdropAmountHouse = 1 * anchor.web3.LAMPORTS_PER_SOL;
    const airdropSignatureHouse = await provider.connection.requestAirdrop(
      house.publicKey,
      airdropAmountHouse
    );
    await provider.connection.confirmTransaction(airdropSignatureHouse, "confirmed");
  });

  describe("Create Game", () => {
    it("Creates a new game successfully!", async () => {
      const wager = 100_000_000; // Example wager in lamports (0.1 SOL)

      // Find PDA using helper function
      const [gameAccountPda, bump] = await findGameAccountPda(creator, wager, program.programId);

      // Invoke the create_game instruction
      await program.rpc.createGame(
        new BN(wager), // Wager as BN
        {
          accounts: {
            gameAccount: gameAccountPda,
            creator: creator.publicKey,
            systemProgram: SystemProgram.programId,
          },
          signers: [creator],
        }
      );

      // Fetch the account and assert initialization
      const gameAccountData = await program.account.gameState.fetch(gameAccountPda);

      // Assertions to verify the game account is initialized correctly
      assert.equal(
        gameAccountData.creator.toBase58(),
        creator.publicKey.toBase58(),
        "Creator address mismatch"
      );
      assert.isNull(gameAccountData.opponent, "Opponent should be null initially");
      assert.deepEqual(
        gameAccountData.creatorMoveHashed,
        Array(32).fill(0),
        "Creator move hashed should be initialized to zeroes"
      );
      assert.deepEqual(
        gameAccountData.joinerMoveHashed,
        Array(32).fill(0),
        "Joiner move hashed should be initialized to zeroes"
      );
      assert.equal(gameAccountData.creatorReady, false, "Creator should not be ready initially");
      assert.equal(gameAccountData.joinerReady, false, "Joiner should not be ready initially");
      assert.equal(gameAccountData.wager.toNumber(), wager, "Wager amount mismatch");
      assert.deepEqual(
        gameAccountData.status,
        { open: {} },
        "Game status should be Open"
      );
      assert.equal(gameAccountData.bump, bump, "Bump seed mismatch");

      // Optional: Log PDA and bump for verification
      console.log("Game Account PDA:", gameAccountPda.toBase58());
      console.log("Stored Bump in Account:", gameAccountData.bump);
    });
  });

  describe("Join Game", () => {
    it("Joins an existing game successfully!", async () => {
      const wager = 100_000_000; // Must match the wager used in createGame

      // Find PDA using helper function
      const [gameAccountPda, bump] = await findGameAccountPda(creator, wager, program.programId);

      // Fetch initial balances for verification
      const initialGameAccountBalance = await provider.connection.getBalance(gameAccountPda);
      const initialJoinerBalance = await provider.connection.getBalance(joiner.publicKey);

      // Invoke the join_game instruction
      await program.rpc.joinGame({
        accounts: {
          gameAccount: gameAccountPda,
          joiner: joiner.publicKey,
          systemProgram: SystemProgram.programId,
        },
        signers: [joiner],
      });

      // Fetch the account and assert joining
      const gameAccountData = await program.account.gameState.fetch(gameAccountPda);

      // Assertions to verify the game account is updated correctly
      assert.equal(
        gameAccountData.opponent.toBase58(),
        joiner.publicKey.toBase58(),
        "Opponent address mismatch"
      );
      assert.deepEqual(
        gameAccountData.status,
        { committed: {} },
        "Game status should be Committed"
      );

      // Verify the transfer of lamports
      const finalGameAccountBalance = await provider.connection.getBalance(gameAccountPda);
      const finalJoinerBalance = await provider.connection.getBalance(joiner.publicKey);

      assert.equal(
        finalGameAccountBalance,
        initialGameAccountBalance + wager,
        "Game account balance should increase by wager"
      );
      assert.equal(
        finalJoinerBalance,
        initialJoinerBalance - wager,
        "Joiner's balance should decrease by wager"
      );

      // Optional: Log balances for verification
      console.log("Initial Game Account Balance:", initialGameAccountBalance);
      console.log("Final Game Account Balance:", finalGameAccountBalance);
      console.log("Initial Joiner Balance:", initialJoinerBalance);
      console.log("Final Joiner Balance:", finalJoinerBalance);
    });

    it("Fails to join a game that's already committed", async () => {
      const wager = 100_000_000; // Must match the wager used in createGame

      // Find PDA using helper function
      const [gameAccountPda, bump] = await findGameAccountPda(creator, wager, program.programId);

      // Attempt to join the game again with a different joiner
      const secondJoiner = Keypair.generate();

      // Airdrop SOL to the second joiner
      const airdropSignatureSecondJoiner = await provider.connection.requestAirdrop(
        secondJoiner.publicKey,
        anchor.web3.LAMPORTS_PER_SOL
      );
      await provider.connection.confirmTransaction(airdropSignatureSecondJoiner, "confirmed");

      try {
        await program.rpc.joinGame({
          accounts: {
            gameAccount: gameAccountPda,
            joiner: secondJoiner.publicKey,
            systemProgram: SystemProgram.programId,
          },
          signers: [secondJoiner],
        });
        assert.fail("The transaction should have failed because the game is not open");
      } catch (err: any) {
        // Assert that the error is the expected one
        assert.include(
          err.message,
          "GameNotOpen",
          "The error message should contain 'GameNotOpen'"
        );
      }
    });
  });

  describe("Select Move", () => {
    it("Creator selects their move successfully!", async () => {
      const wager = 100_000_000; // Must match the wager used in createGame
      const original_move = 0; // 0 = Rock
      const salt = "creator_salt";

      // Find PDA using helper function
      const [gameAccountPda, bump] = await findGameAccountPda(creator, wager, program.programId);

      // Invoke the select_move instruction as creator
      await program.rpc.selectMove(
        original_move,
        salt,
        {
          accounts: {
            gameAccount: gameAccountPda,
            player: creator.publicKey,
            systemProgram: SystemProgram.programId,
          },
          signers: [creator],
        }
      );

      // Fetch the account and assert the move is recorded correctly
      const gameAccountData = await program.account.gameState.fetch(gameAccountPda);

      // Compute expected hash
      const expectedHash = hashMove(original_move, salt);

      // Assertions
      assert.deepEqual(
        gameAccountData.creatorMoveHashed,
        Array.from(expectedHash),
        "Creator's hashed move does not match expected hash"
      );
    });

    it("Joiner selects their move successfully!", async () => {
      const wager = 100_000_000; // Must match the wager used in createGame
      const original_move = 1; // 1 = Paper
      const salt = "joiner_salt";

      // Find PDA using helper function
      const [gameAccountPda, bump] = await findGameAccountPda(creator, wager, program.programId);

      // Invoke the select_move instruction as joiner
      await program.rpc.selectMove(
        original_move,
        salt,
        {
          accounts: {
            gameAccount: gameAccountPda,
            player: joiner.publicKey,
            systemProgram: SystemProgram.programId,
          },
          signers: [joiner],
        }
      );

      // Fetch the account and assert the move is recorded correctly
      const gameAccountData = await program.account.gameState.fetch(gameAccountPda);

      // Compute expected hash
      const expectedHash = hashMove(original_move, salt);

      // Assertions
      assert.deepEqual(
        gameAccountData.joinerMoveHashed,
        Array.from(expectedHash),
        "Joiner's hashed move does not match expected hash"
      );
    });

    it("Unauthorized user cannot select a move", async () => {
      const wager = 100_000_000; // Must match the wager used in createGame
      const original_move = 2; // 2 = Scissors
      const salt = "unauthorized_salt";

      // Find PDA using helper function
      const [gameAccountPda, bump] = await findGameAccountPda(creator, wager, program.programId);

      // Generate a new keypair for unauthorized user
      const unauthorizedUser = Keypair.generate();

      // Airdrop SOL to the unauthorized user
      const airdropSignatureUnauthorized = await provider.connection.requestAirdrop(
        unauthorizedUser.publicKey,
        anchor.web3.LAMPORTS_PER_SOL
      );
      await provider.connection.confirmTransaction(airdropSignatureUnauthorized, "confirmed");

      try {
        // Attempt to invoke the select_move instruction as unauthorized user
        await program.rpc.selectMove(
          original_move,
          salt,
          {
            accounts: {
              gameAccount: gameAccountPda,
              player: unauthorizedUser.publicKey,
              systemProgram: SystemProgram.programId,
            },
            signers: [unauthorizedUser],
          }
        );
        assert.fail("The transaction should have failed because the user is unauthorized");
      } catch (err: any) {
        // Assert that the error is the expected one
        assert.include(
          err.message,
          "Unauthorized",
          "The error message should contain 'Unauthorized'"
        );
      }
    });
  });

  describe("Ready Up", () => {
    it("Creator ready up successfully after selecting a move", async () => {
      const wager = 100_000_000; // Must match the wager used in createGame

      // Find PDA using helper function
      const [gameAccountPda, bump] = await findGameAccountPda(creator, wager, program.programId);

      // Invoke the ready_up instruction as creator
      await program.rpc.readyUp({
        accounts: {
          gameAccount: gameAccountPda,
          player: creator.publicKey,
          systemProgram: SystemProgram.programId,
        },
        signers: [creator],
      });

      // Fetch the account and assert the ready status
      const gameAccountData = await program.account.gameState.fetch(gameAccountPda);
      

      // Inside the failing test
      console.log("Game Status:", gameAccountData.status);

      // Assertions
      assert.equal(
        gameAccountData.creatorReady,
        true,
        "Creator should be marked as ready"
      );
      assert.equal(
        gameAccountData.joinerReady,
        false,
        "Joiner should not be marked as ready yet"
      );
      assert.deepEqual(
        gameAccountData.status,
        { committed: {} },
        "Game status should remain Committed until both players are ready"
      );
    });

    it("Joiner ready up successfully after selecting a move", async () => {
      const wager = 100_000_000; // Must match the wager used in createGame

      // Find PDA using helper function
      const [gameAccountPda, bump] = await findGameAccountPda(creator, wager, program.programId);

      // Invoke the ready_up instruction as joiner
      await program.rpc.readyUp({
        accounts: {
          gameAccount: gameAccountPda,
          player: joiner.publicKey,
          systemProgram: SystemProgram.programId,
        },
        signers: [joiner],
      });

      // Fetch the account and assert the ready status and game status
      const gameAccountData = await program.account.gameState.fetch(gameAccountPda);

      // Assertions
      assert.equal(
        gameAccountData.creatorReady,
        true,
        "Creator should be marked as ready"
      );
      assert.equal(
        gameAccountData.joinerReady,
        true,
        "Joiner should be marked as ready"
      );
      assert.deepEqual(
        gameAccountData.status,
        { ended: {} },
        "Game status should be Ended after both players are ready"
      );
    });

    it("Player cannot ready up without selecting a move", async () => {
      const wager = 100_000_000; // Must match the wager used in createGame

      // Create a new game for isolation
      const newCreator = Keypair.generate();
      const newJoiner = Keypair.generate();

      // Airdrop SOL to new creator and new joiner
      const airdropSignatureNewCreator = await provider.connection.requestAirdrop(
        newCreator.publicKey,
        2 * anchor.web3.LAMPORTS_PER_SOL
      );
      await provider.connection.confirmTransaction(airdropSignatureNewCreator, "confirmed");

      const airdropSignatureNewJoiner = await provider.connection.requestAirdrop(
        newJoiner.publicKey,
        2 * anchor.web3.LAMPORTS_PER_SOL
      );
      await provider.connection.confirmTransaction(airdropSignatureNewJoiner, "confirmed");

      // Find PDA for the new game
      const [newGameAccountPda, newBump] = await findGameAccountPda(newCreator, wager, program.programId);

      // Create the new game
      await program.rpc.createGame(
        new BN(wager),
        {
          accounts: {
            gameAccount: newGameAccountPda,
            creator: newCreator.publicKey,
            systemProgram: SystemProgram.programId,
          },
          signers: [newCreator],
        }
      );

      // Join the new game
      await program.rpc.joinGame({
        accounts: {
          gameAccount: newGameAccountPda,
          joiner: newJoiner.publicKey,
          systemProgram: SystemProgram.programId,
        },
        signers: [newJoiner],
      });

      // Attempt to ready up as creator without selecting a move
      try {
        await program.rpc.readyUp({
          accounts: {
            gameAccount: newGameAccountPda,
            player: newCreator.publicKey,
            systemProgram: SystemProgram.programId,
          },
          signers: [newCreator],
        });
        assert.fail("The transaction should have failed because the creator has not selected a move");
      } catch (err: any) {
        // Assert that the error is the expected one
        assert.include(
          err.message,
          "MoveNotSelected",
          "The error message should contain 'MoveNotSelected'"
        );
      }
    });

    it("Unauthorized user cannot ready up", async () => {
      const wager = 100_000_000; // Must match the wager used in createGame

      // Find PDA using helper function
      const [gameAccountPda, bump] = await findGameAccountPda(creator, wager, program.programId);

      // Generate a new keypair for unauthorized user
      const unauthorizedUser = Keypair.generate();

      // Airdrop SOL to the unauthorized user
      const airdropSignatureUnauthorized = await provider.connection.requestAirdrop(
        unauthorizedUser.publicKey,
        anchor.web3.LAMPORTS_PER_SOL
      );
      await provider.connection.confirmTransaction(airdropSignatureUnauthorized, "confirmed");

      try {
        // Attempt to invoke the ready_up instruction as unauthorized user
        await program.rpc.readyUp({
          accounts: {
            gameAccount: gameAccountPda,
            player: unauthorizedUser.publicKey,
            systemProgram: SystemProgram.programId,
          },
          signers: [unauthorizedUser],
        });
        assert.fail("The transaction should have failed because the user is unauthorized");
      } catch (err: any) {
        // Assert that the error is the expected one
        assert.include(
          err.message,
          "Unauthorized",
          "The error message should contain 'Unauthorized'"
        );
      }
    });

    it("Cannot ready up after the game has ended", async () => {
      const wager = 100_000_000; // Must match the wager used in createGame

      // Find PDA using helper function
      const [gameAccountPda, bump] = await findGameAccountPda(creator, wager, program.programId);

      // Attempt to ready up again as creator after the game has ended
      try {
        await program.rpc.readyUp({
          accounts: {
            gameAccount: gameAccountPda,
            player: creator.publicKey,
            systemProgram: SystemProgram.programId,
          },
          signers: [creator],
        });

        const gameAccountData = await program.account.gameState.fetch(gameAccountPda);
        console.log("Game Status:", gameAccountData.status);

        assert.fail("The transaction should have failed because the game has already ended");
      } catch (err: any) {
        // Assert that the error is the expected one
        assert.include(
          err.message,
          "GameAlreadyEnded",
          "The error message should contain 'GameAlreadyEnded'"
        );
      }
    });
  });
});