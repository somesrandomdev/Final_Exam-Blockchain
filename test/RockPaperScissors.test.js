const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("RockPaperScissors", function () {
  let rps;
  let owner;
  let player1;
  let player2;
  const bet = ethers.parseEther("0.01");

  async function commitHash(move, secret) {
    return rps.getCommitHash(move, secret);
  }

  beforeEach(async () => {
    [owner, player1, player2] = await ethers.getSigners();

    const RPS = await ethers.getContractFactory("RockPaperScissors");
    rps = await RPS.deploy();
    await rps.waitForDeployment();
  });

  it("deploys with the correct initial state", async () => {
    expect(await rps.nextGameId()).to.equal(0n);
    expect(await rps.houseFeePercent()).to.equal(5n);
    expect(await rps.owner()).to.equal(owner.address);
  });

  it("creates a game with an ETH bet", async () => {
    const hash = await commitHash(1, "secret");

    await expect(rps.connect(player1).createGame(hash, { value: bet }))
      .to.emit(rps, "GameCreated")
      .withArgs(0n, player1.address, bet);
  });

  it("allows player 2 to join with a matching bet", async () => {
    const hash1 = await commitHash(1, "secret1");
    const hash2 = await commitHash(2, "secret2");

    await rps.connect(player1).createGame(hash1, { value: bet });

    await expect(rps.connect(player2).joinGame(0, hash2, { value: bet }))
      .to.emit(rps, "PlayerJoined")
      .withArgs(0n, player2.address);
  });

  it("resolves the game when both players reveal", async () => {
    const hash1 = await commitHash(1, "s1");
    const hash2 = await commitHash(3, "s2");

    await rps.connect(player1).createGame(hash1, { value: bet });
    await rps.connect(player2).joinGame(0, hash2, { value: bet });
    await rps.connect(player1).revealMove(0, 1, "s1");

    await expect(rps.connect(player2).revealMove(0, 3, "s2")).to.emit(rps, "GameResolved");

    const game = await rps.games(0);
    expect(game.winner).to.equal(player1.address);
  });

  it("refunds both players on a draw", async () => {
    const hash1 = await commitHash(1, "s1");
    const hash2 = await commitHash(1, "s2");

    await rps.connect(player1).createGame(hash1, { value: bet });
    await rps.connect(player2).joinGame(0, hash2, { value: bet });
    await rps.connect(player1).revealMove(0, 1, "s1");
    await rps.connect(player2).revealMove(0, 1, "s2");

    const game = await rps.games(0);
    expect(game.winner).to.equal(ethers.ZeroAddress);
  });

  it("allows a timeout claim if an opponent never joins", async () => {
    const hash = await commitHash(1, "s");

    await rps.connect(player1).createGame(hash, { value: bet });

    for (let i = 0; i < 51; i += 1) {
      await ethers.provider.send("evm_mine");
    }

    await expect(rps.connect(player1).claimCommitTimeout(0))
      .to.emit(rps, "GameCancelled")
      .withArgs(0n, player1.address, "Commit timeout");
  });

  it("rejects self-play", async () => {
    const hash = await commitHash(1, "s");

    await rps.connect(player1).createGame(hash, { value: bet });

    await expect(rps.connect(player1).joinGame(0, hash, { value: bet })).to.be.revertedWith(
      "No self-play"
    );
  });

  it("rejects the wrong bet amount", async () => {
    const hash1 = await commitHash(1, "s1");
    const hash2 = await commitHash(2, "s2");

    await rps.connect(player1).createGame(hash1, { value: bet });

    await expect(
      rps.connect(player2).joinGame(0, hash2, { value: ethers.parseEther("0.02") })
    ).to.be.revertedWith("Bet mismatch");
  });
});
