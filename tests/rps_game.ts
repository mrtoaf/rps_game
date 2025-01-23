import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { RpsGame } from "../target/types/rps_game";
import { assert } from "chai";
import { Keypair, PublicKey } from "@solana/web3.js";
import { sha256 } from "js-sha256";
import { BN } from "bn.js"; // Import BN for big number handling

describe("rps_game", () => {
  // Configure the client to use the local cluster.
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.RpsGame as Program<RpsGame>;

  // Define keypairs
  const creator = Keypair.generate();
  const joiner = Keypair.generate();
  const house = Keypair.generate(); // House account can be a Keypair or a predefined account

  // Shared salt variables
  let creatorSalt: string;
  let joinerSalt: string;

  // Helper function to derive PDA
  const findGameAccountPda = async (
    creator: anchor.web3.Keypair,
    wager: number,
    programId: anchor.web3.PublicKey
  ): Promise<[anchor.web3.PublicKey, number]> => {
    const wagerBn = new BN(wager);
    const wagerBuffer = wagerBn.toArrayLike(Buffer, "le", 8); // 8-byte little-endian

    return anchor.web3.PublicKey.findProgramAddress(
      [
        Buffer.from("game"),
        creator.publicKey.toBuffer(),
        wagerBuffer,
      ],
      programId
    );
  };

  before(async () => {
    // Airdrop SOL to creator and joiner for tests
    const airdropSignatureCreator = await provider.connection.requestAirdrop(
      creator.publicKey,
      2 * anchor.web3.LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(airdropSignatureCreator, "confirmed");

    const airdropSignatureJoiner = await provider.connection.requestAirdrop(
      joiner.publicKey,
      2 * anchor.web3.LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(airdropSignatureJoiner, "confirmed");

    const airdropSignatureHouse = await provider.connection.requestAirdrop(
      house.publicKey,
      1 * anchor.web3.LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(airdropSignatureHouse, "confirmed");
  });

  it("Is initialized!", async () => {
    const wager = 100_000_000; // Example wager in lamports
    const creatorMove = 0; // Rock
    creatorSalt = "random_salt"; // Assigning salt

    // Compute creator's hashed move
    const creatorHash = sha256.create();
    creatorHash.update(Buffer.from([creatorMove]));
    creatorHash.update(Buffer.from(creatorSalt));
    const creator_move_hashed = creatorHash.array(); // Uint8Array

    // Find PDA using helper function
    const [gameAccountPda, bump] = await findGameAccountPda(creator, wager, program.programId);

    await program.rpc.createGame(
      creator_move_hashed,
      new BN(wager),
      {
        accounts: {
          gameAccount: gameAccountPda,
          creator: creator.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId,
        },
        signers: [creator],
      }
    );

    // Fetch the account and assert initialization
    const gameAccount = await program.account.gameState.fetch(gameAccountPda);
    assert.equal(gameAccount.creator.toBase58(), creator.publicKey.toBase58());
    assert.isNull(gameAccount.opponent);
    assert.isDefined(gameAccount.status.open); // Corrected assertion
    assert.equal(gameAccount.bump, bump); // Verify bump consistency

    // Optional: Log PDA and bump for verification
    console.log("Game Account PDA:", gameAccountPda.toBase58());
    console.log("Stored Bump in Account:", gameAccount.bump);
  });

  it("Join Game test", async () => {
    const wager = 100_000_000; // Must match the wager used in createGame
    const joinerMove = 2; // Scissors
    joinerSalt = "another_random_salt"; // Assigning salt

    // Compute joiner's hashed move
    const joinerHash = sha256.create();
    joinerHash.update(Buffer.from([joinerMove]));
    joinerHash.update(Buffer.from(joinerSalt));
    const joiner_move_hashed = joinerHash.array(); // Uint8Array

    // Find PDA using helper function
    const [gameAccountPda, bump] = await findGameAccountPda(creator, wager, program.programId);

    await program.rpc.joinGame(
      joiner_move_hashed,
      {
        accounts: {
          gameAccount: gameAccountPda,
          joiner: joiner.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId,
        },
        signers: [joiner],
      }
    );

    // Fetch the account and assert joining
    const gameAccount = await program.account.gameState.fetch(gameAccountPda);
    assert.equal(gameAccount.opponent?.toBase58(), joiner.publicKey.toBase58());
    assert.isDefined(gameAccount.status.committed); // Corrected assertion

    // Optional: Log PDA for verification
    console.log("Game Account PDA after joining:", gameAccountPda.toBase58());
  });

  it("Reveal Move test (Creator wins Rock vs Scissors)", async () => {
    const original_move_creator = 0; // Rock
    const original_move_joiner = 2; // Scissors

    // Use the same salts as in previous tests
    // Creator reveals move with creatorSalt
    const creatorHash = sha256.create();
    creatorHash.update(Buffer.from([original_move_creator]));
    creatorHash.update(Buffer.from(creatorSalt));
    const creator_move_revealed = creatorHash.array(); // Uint8Array

    // Joiner reveals move with joinerSalt
    const joinerHash = sha256.create();
    joinerHash.update(Buffer.from([original_move_joiner]));
    joinerHash.update(Buffer.from(joinerSalt));
    const joiner_move_revealed = joinerHash.array(); // Uint8Array

    // Find PDA using helper function
    const [gameAccountPda, bump] = await findGameAccountPda(creator, 100_000_000, program.programId);

    // Reveal creator's move
    await program.rpc.revealMove(
      original_move_creator,
      creatorSalt, // Use the same salt used during creation
      {
        accounts: {
          gameAccount: gameAccountPda,
          player: creator.publicKey,
          house: house.publicKey,
          creator: creator.publicKey,
          joiner: joiner.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId,
        },
        signers: [creator],
      }
    );

    // Reveal joiner's move
    await program.rpc.revealMove(
      original_move_joiner,
      joinerSalt, // Use the same salt used during joining
      {
        accounts: {
          gameAccount: gameAccountPda,
          player: joiner.publicKey,
          house: house.publicKey,
          creator: creator.publicKey,
          joiner: joiner.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId,
        },
        signers: [joiner],
      }
    );

    // Fetch the account and assert the game has ended
    const gameAccount = await program.account.gameState.fetch(gameAccountPda);
    assert.isDefined(gameAccount.status.ended); // Corrected assertion
    assert.deepEqual(gameAccount.status, { ended: {} }); // Deep equality for enum

    // Optional: Log game status for verification
    console.log("Game Status after reveal:", gameAccount.status);
  });
});