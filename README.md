# ChainRPS Frontend

ChainRPS is a React frontend for a Sepolia Rock Paper Scissors smart contract. The app uses a commit-reveal flow so players choose a move privately, join with matching bets, then reveal the original move and secret to resolve the game on-chain.

## Contract

- Network: Sepolia
- Contract address: `0x83D917b606fE4C89ff178A5fd9d7D05Ca8605f38`
- Wallet: MetaMask
- Web3 library: `ethers@6`

The ABI used by the frontend is defined directly in [src/App.js](src/App.js).

## What We Built

- React app created with Create React App
- Dark ChainRPS UI with indigo and teal accents
- MetaMask connection and Sepolia switching
- Game creation with ETH bet
- Game joining with matching bet
- Commit hash generation through the contract, with a local ethers fallback
- Move reveal flow for both players
- Pot display, phase tracker, player status, win streak, recent games, and timeout buttons
- Saved game ID after refresh
- Saved move and secret per wallet/game so a player can return and reveal
- `Load Game` button for resuming a game instead of trying to join it again
- `Logout` button that clears the local wallet session while keeping the saved game ID

## Project Files

- [src/App.js](src/App.js): wallet logic, contract calls, game state, and UI
- [src/App.css](src/App.css): dark theme styling
- [src/App.test.js](src/App.test.js): basic render and saved-game tests
- [contracts/RockPaperScissors.sol](contracts/RockPaperScissors.sol): commit-reveal game contract
- [test/RockPaperScissors.test.js](test/RockPaperScissors.test.js): Hardhat unit tests for the contract
- [hardhat.config.js](hardhat.config.js): local Hardhat test configuration
- [package.json](package.json): scripts and dependencies

## Setup

Install dependencies:

```bash
npm install
```

Start the development server:

```bash
npm start
```

By default the app opens at:

```text
http://localhost:3000
```

If port 3000 is busy, use another port:

```bash
set PORT=3005&&npm start
```

Then open:

```text
http://localhost:3005
```

## Testing the Game

Use two different MetaMask accounts on Sepolia. Both accounts need Sepolia ETH.

1. Connect account 1.
2. Choose Rock, Paper, or Scissors.
3. Enter a secret phrase. Save or remember it.
4. Set a bet amount.
5. Click `Create Game`.
6. Copy the game ID.
7. Click `Logout` or switch MetaMask to account 2.
8. Connect account 2.
9. Choose a move and enter a secret phrase.
10. Confirm the saved game ID is in the join field.
11. Click `Join Game`.
12. Click `Reveal Move` with account 2.
13. Log out or switch back to account 1.
14. Click `Load Game` if the app does not auto-load it.
15. Click `Reveal Move` with account 1.
16. The contract resolves the winner or refunds on a draw.

## Important Behavior

Game IDs are simple numbers. If the copied ID is `1`, that is normal: it means contract game number 1.

`Failed to join game: execution reverted: "Not open"` means the game cannot accept another player. This usually happens when:

- player 2 already joined
- the game was cancelled
- the game was resolved
- you are clicking `Join Game` when you should click `Load Game`

After a game has two players, use `Load Game` to resume it and `Reveal Move` to continue. Do not click `Join Game` again for that same game.

## Logout Notes

The `Logout` button clears the app's local wallet state and tries to revoke MetaMask account permission with `wallet_revokePermissions`. Some wallets may ignore that method. Even then, the app still returns to the disconnected screen.

Logout keeps the saved game ID so it is easier to reconnect with the next account and continue testing.

## Verify

Run a production build:

```bash
npm run build
```

Run tests once:

```bash
npx react-scripts test --watchAll=false --runInBand
```

Run the smart contract unit tests:

```bash
npm run test:hardhat
```
