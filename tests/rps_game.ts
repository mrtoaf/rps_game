import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { RpsGame } from "../target/types/rps_game";

describe("rps_game", () => {
  // Configure the client to use the local cluster.
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.RpsGame as Program<RpsGame>;

  it("Is initialized!", async () => {
    const { SystemProgram } = anchor.web3;
    const hashedMove = new Uint8Array(32); // 32-byte array of zeros
    const gameAccount = anchor.web3.Keypair.generate();
    const wager = new anchor.BN(1 * anchor.web3.LAMPORTS_PER_SOL); // 1 SOL in lamports

    await program.rpc.createGame(
      hashedMove,
      wager,
      {
        accounts: {
          gameAccount: gameAccount.publicKey,
          creator: provider.wallet.publicKey,
          systemProgram: SystemProgram.programId,
        },
        signers: [gameAccount],
      }
    );

    const gameAccountData = await program.account.gameState.fetch(gameAccount.publicKey);
    console.log(gameAccountData);
  });
});
