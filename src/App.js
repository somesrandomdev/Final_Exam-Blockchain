import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ethers } from 'ethers';
import './App.css';

const CONTRACT_ADDRESS = '0x83D917b606fE4C89ff178A5fd9d7D05Ca8605f38';
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const LAST_GAME_ID_KEY = 'chainrps:lastGameId';
const PLAYER_COMMITMENT_PREFIX = 'chainrps:playerCommitment';

const SEPOLIA = {
  chainId: '0xaa36a7',
  chainName: 'Sepolia',
  nativeCurrency: {
    name: 'Sepolia Ether',
    symbol: 'ETH',
    decimals: 18
  },
  rpcUrls: ['https://rpc.sepolia.org'],
  blockExplorerUrls: ['https://sepolia.etherscan.io']
};

const CONTRACT_ABI = [
  'function createGame(bytes32 _commitHash) external payable returns (uint256)',
  'function joinGame(uint256 _gameId, bytes32 _commitHash) external payable',
  'function revealMove(uint256 _gameId, uint8 _move, string memory _secret) external',
  'function claimCommitTimeout(uint256 _gameId) external',
  'function claimRevealTimeout(uint256 _gameId) external',
  'function getCommitHash(uint8 _move, string memory _secret) external pure returns (bytes32)',
  'function getGameInfo(uint256 _gameId) external view returns (address, address, uint256, uint8, uint256, uint256, address, bool, bool)',
  'function games(uint256) external view returns (address, address, bytes32, bytes32, uint8, uint8, uint256, uint8, uint256, uint256, address, bool, bool)',
  'function nextGameId() external view returns (uint256)',
  'event GameCreated(uint256 indexed gameId, address indexed player1, uint256 betAmount)',
  'event PlayerJoined(uint256 indexed gameId, address indexed player2)',
  'event MoveRevealed(uint256 indexed gameId, address indexed player, uint8 move)',
  'event GameResolved(uint256 indexed gameId, address indexed winner, uint256 payout)',
  'event GameCancelled(uint256 indexed gameId, address indexed caller, string reason)'
];

const MOVES = [
  { id: 1, emoji: '✊', name: 'Rock' },
  { id: 2, emoji: '✋', name: 'Paper' },
  { id: 3, emoji: '✌️', name: 'Scissors' }
];

const PHASES = ['commit', 'reveal', 'resolve'];

const MOVE_DETAILS = {
  1: { id: 1, emoji: '\u270a', name: 'Rock', beats: 'Beats scissors' },
  2: { id: 2, emoji: '\u270b', name: 'Paper', beats: 'Beats rock' },
  3: { id: 3, emoji: '\u270c\ufe0f', name: 'Scissors', beats: 'Beats paper' }
};

function isZeroAddress(address) {
  return !address || address.toLowerCase() === ZERO_ADDRESS;
}

function shortenAddress(address) {
  if (isZeroAddress(address)) return 'Waiting...';
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function sameAddress(left, right) {
  return Boolean(left && right && left.toLowerCase() === right.toLowerCase());
}

function getMoveDetails(moveId) {
  return MOVE_DETAILS[Number(moveId)] || {
    id: 0,
    emoji: '?',
    name: 'Unknown',
    beats: 'Move hidden'
  };
}

function formatClockTime() {
  return new Date().toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit'
  });
}

function getReadableError(error) {
  if (error?.code === 4001 || error?.info?.error?.code === 4001) {
    return 'Request rejected in wallet.';
  }

  return (
    error?.shortMessage ||
    error?.reason ||
    error?.info?.error?.message ||
    error?.message ||
    'Something went wrong.'
  );
}

function readLastGameId() {
  if (typeof window === 'undefined') return '';

  try {
    return window.localStorage.getItem(LAST_GAME_ID_KEY) || '';
  } catch {
    return '';
  }
}

function storeLastGameId(gameId) {
  if (!gameId || typeof window === 'undefined') return;

  try {
    window.localStorage.setItem(LAST_GAME_ID_KEY, gameId.toString());
  } catch {
    // Local storage is just a convenience; the chain remains the source of truth.
  }
}

function getPlayerCommitmentKey(gameId, playerAddress) {
  return `${PLAYER_COMMITMENT_PREFIX}:${gameId}:${playerAddress.toLowerCase()}`;
}

function readPlayerCommitment(gameId, playerAddress) {
  if (!gameId || !playerAddress || typeof window === 'undefined') return null;

  try {
    const stored = window.localStorage.getItem(getPlayerCommitmentKey(gameId, playerAddress));
    if (!stored) return null;

    const parsed = JSON.parse(stored);
    if (!parsed?.move || !parsed?.secret) return null;

    return {
      move: Number(parsed.move),
      secret: parsed.secret
    };
  } catch {
    return null;
  }
}

function storePlayerCommitment(gameId, playerAddress, move, secret) {
  if (!gameId || !playerAddress || !move || !secret || typeof window === 'undefined') return;

  try {
    window.localStorage.setItem(
      getPlayerCommitmentKey(gameId, playerAddress),
      JSON.stringify({ move: Number(move), secret })
    );
  } catch {
    // If storage is blocked, the player can still reveal by re-entering the same move and secret.
  }
}

function getGameCreatedId(contract, logs) {
  for (const log of logs) {
    try {
      const parsed = contract.interface.parseLog(log);
      if (parsed?.name === 'GameCreated') {
        return parsed.args.gameId.toString();
      }
    } catch {
      // Ignore logs from other contracts in the transaction receipt.
    }
  }

  return null;
}

function App() {
  const [provider, setProvider] = useState(null);
  const [contract, setContract] = useState(null);
  const [account, setAccount] = useState('');
  const [balance, setBalance] = useState('0');
  const [blockNumber, setBlockNumber] = useState(0);
  const [isConnected, setIsConnected] = useState(false);

  const [currentGameId, setCurrentGameId] = useState('');
  const [joinGameId, setJoinGameId] = useState(readLastGameId);
  const [gameState, setGameState] = useState(null);
  const [selectedMove, setSelectedMove] = useState(null);
  const [secret, setSecret] = useState('');
  const [commitHash, setCommitHash] = useState('');
  const [betAmount, setBetAmount] = useState('0.01');
  const [isPlayer1, setIsPlayer1] = useState(false);
  const [isPlayer2, setIsPlayer2] = useState(false);
  const [phase, setPhase] = useState('idle');

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [winStreak, setWinStreak] = useState(0);
  const [recentGames, setRecentGames] = useState([]);

  const resolvedGamesRef = useRef(new Set());

  const resetGame = useCallback(() => {
    setCurrentGameId('');
    setGameState(null);
    setSelectedMove(null);
    setSecret('');
    setCommitHash('');
    setIsPlayer1(false);
    setIsPlayer2(false);
    setPhase('idle');
    setError('');
    setSuccess('');
  }, []);

  const refreshBalance = useCallback(
    async (nextProvider = provider, nextAccount = account) => {
      if (!nextProvider || !nextAccount) return;

      const nextBalance = await nextProvider.getBalance(nextAccount);
      setBalance(ethers.formatEther(nextBalance));
    },
    [account, provider]
  );

  const connectWallet = useCallback(async () => {
    setError('');
    setSuccess('');

    if (!window.ethereum) {
      setError('Please install MetaMask to play.');
      return;
    }

    setLoading(true);

    try {
      try {
        await window.ethereum.request({
          method: 'wallet_switchEthereumChain',
          params: [{ chainId: SEPOLIA.chainId }]
        });
      } catch (switchError) {
        if (switchError?.code === 4902) {
          await window.ethereum.request({
            method: 'wallet_addEthereumChain',
            params: [SEPOLIA]
          });
        } else {
          throw switchError;
        }
      }

      await window.ethereum.request({ method: 'eth_requestAccounts' });

      const browserProvider = new ethers.BrowserProvider(window.ethereum);
      const signer = await browserProvider.getSigner();
      const address = await signer.getAddress();
      const chainRps = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, signer);

      setProvider(browserProvider);
      setContract(chainRps);
      setAccount(address);
      setIsConnected(true);

      const [nextBalance, nextBlock] = await Promise.all([
        browserProvider.getBalance(address),
        browserProvider.getBlockNumber()
      ]);

      setBalance(ethers.formatEther(nextBalance));
      setBlockNumber(nextBlock);
    } catch (connectError) {
      setError(`Failed to connect: ${getReadableError(connectError)}`);
    } finally {
      setLoading(false);
    }
  }, []);

  const disconnectWallet = useCallback(async () => {
    const savedGameId = currentGameId || joinGameId || readLastGameId();

    setLoading(true);
    setError('');
    setSuccess('');

    try {
      if (window.ethereum?.request) {
        await window.ethereum.request({
          method: 'wallet_revokePermissions',
          params: [{ eth_accounts: {} }]
        });
      }
    } catch {
      // Some wallets do not support permission revocation; clearing app state still logs out locally.
    } finally {
      setProvider(null);
      setContract(null);
      setAccount('');
      setBalance('0');
      setBlockNumber(0);
      setIsConnected(false);
      resetGame();

      if (savedGameId) {
        setJoinGameId(savedGameId);
        storeLastGameId(savedGameId);
        setSuccess(`Logged out. Game #${savedGameId} is saved for your next connection.`);
      } else {
        setSuccess('Logged out.');
      }

      setLoading(false);
    }
  }, [currentGameId, joinGameId, resetGame]);

  const addToRecentGames = useCallback((game) => {
    setRecentGames((previous) => [game, ...previous].slice(0, 10));
  }, []);

  const markGameResolved = useCallback(
    async (gameId, winner, payout) => {
      const id = gameId.toString();
      if (resolvedGamesRef.current.has(id)) return;
      resolvedGamesRef.current.add(id);

      const normalizedWinner = winner.toLowerCase();
      const isDraw = isZeroAddress(normalizedWinner);
      const isWin = account && normalizedWinner === account.toLowerCase();
      const payoutEth = payout ? ethers.formatEther(payout) : '0';
      let playerMove = selectedMove;
      let opponentMove = 0;

      try {
        if (contract) {
          const game = await contract.games(id);
          const player1 = game[0];
          const player2 = game[1];
          const player1Move = Number(game[4]);
          const player2Move = Number(game[5]);

          if (sameAddress(account, player1)) {
            playerMove = player1Move;
            opponentMove = player2Move;
          } else if (sameAddress(account, player2)) {
            playerMove = player2Move;
            opponentMove = player1Move;
          } else {
            playerMove = player1Move;
            opponentMove = player2Move;
          }
        }
      } catch {
        // The game can still be listed even if a historical read briefly fails.
      }

      if (isWin) {
        setWinStreak((previous) => previous + 1);
        setSuccess(`You won ${payoutEth} ETH.`);
      } else if (isDraw) {
        setSuccess('Draw. Both players were refunded.');
      } else {
        setWinStreak(0);
        setSuccess('You lost this round.');
      }

      addToRecentGames({
        id,
        isWin,
        isDraw,
        payout: payoutEth,
        betAmount,
        playerMove,
        opponentMove,
        timestamp: formatClockTime()
      });
    },
    [account, addToRecentGames, betAmount, contract, selectedMove]
  );

  const generateCommitHash = useCallback(
    async (move, phrase) => {
      if (contract) {
        try {
          return await contract.getCommitHash(move, phrase);
        } catch {
          // The local fallback mirrors Solidity's keccak256(abi.encode(...)).
        }
      }

      return ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(['uint8', 'string'], [Number(move), phrase]));
    },
    [contract]
  );

  const checkGameState = useCallback(
    async (gameId = currentGameId) => {
      if (!contract || !gameId) return;

      try {
        const info = await contract.getGameInfo(gameId);
        const [
          player1,
          player2,
          bet,
          state,
          commitDeadline,
          revealDeadline,
          winner,
          player1Revealed,
          player2Revealed
        ] = info;

        const stateNumber = Number(state);
        const hasPlayer2 = !isZeroAddress(player2);
        const playerOne = account && player1.toLowerCase() === account.toLowerCase();
        const playerTwo = account && player2.toLowerCase() === account.toLowerCase();

        setGameState({
          player1,
          player2,
          betAmount: ethers.formatEther(bet),
          state: stateNumber,
          commitDeadline: Number(commitDeadline),
          revealDeadline: Number(revealDeadline),
          winner,
          player1Revealed,
          player2Revealed
        });

        setIsPlayer1(Boolean(playerOne));
        setIsPlayer2(Boolean(playerTwo));

        if (stateNumber === 3) {
          setPhase('resolve');
          await markGameResolved(gameId, winner, bet * 2n);
        } else if (stateNumber === 4) {
          setPhase('resolve');
        } else if (hasPlayer2) {
          setPhase('reveal');
        } else {
          setPhase('commit');
        }
      } catch (stateError) {
        setError(`Could not load game #${gameId}: ${getReadableError(stateError)}`);
      }
    },
    [account, contract, currentGameId, markGameResolved]
  );

  const createGame = useCallback(async () => {
    if (!contract || !selectedMove || !secret.trim()) {
      setError('Select a move and enter a secret phrase.');
      return;
    }

    let parsedBet;
    try {
      parsedBet = ethers.parseEther(betAmount || '0');
    } catch {
      setError('Enter a valid ETH bet amount.');
      return;
    }

    if (parsedBet <= 0n) {
      setError('Bet amount must be greater than zero.');
      return;
    }

    setLoading(true);
    setError('');
    setSuccess('');

    try {
      const hash = await generateCommitHash(selectedMove, secret);
      setCommitHash(hash);

      const transaction = await contract.createGame(hash, { value: parsedBet });
      const receipt = await transaction.wait();
      const createdGameId = getGameCreatedId(contract, receipt.logs);

      if (!createdGameId) {
        throw new Error('Transaction succeeded, but the GameCreated event was not found.');
      }

      setCurrentGameId(createdGameId);
      setJoinGameId(createdGameId);
      storeLastGameId(createdGameId);
      storePlayerCommitment(createdGameId, account, selectedMove, secret);
      setIsPlayer1(true);
      setIsPlayer2(false);
      setPhase('commit');
      setSuccess(`Game #${createdGameId} created. Share the game ID with your opponent.`);

      await Promise.all([checkGameState(createdGameId), refreshBalance()]);
    } catch (createError) {
      setError(`Failed to create game: ${getReadableError(createError)}`);
    } finally {
      setLoading(false);
    }
  }, [
    account,
    betAmount,
    checkGameState,
    contract,
    generateCommitHash,
    refreshBalance,
    secret,
    selectedMove
  ]);

  const loadGame = useCallback(
    async (gameId = joinGameId, options = {}) => {
      const targetGameId = gameId.toString().trim();
      const silent = Boolean(options.silent);

      if (!contract || !targetGameId) {
        if (!silent) setError('Enter a game ID to load.');
        return false;
      }

      if (!/^\d+$/.test(targetGameId)) {
        if (!silent) setError('Enter a valid numeric game ID.');
        return false;
      }

      if (!silent) {
        setLoading(true);
        setError('');
        setSuccess('');
      }

      try {
        const info = await contract.getGameInfo(targetGameId);
        const [player1, player2, , state] = info;
        const stateNumber = Number(state);
        const hasPlayer2 = !isZeroAddress(player2);
        const playerOne = account && player1.toLowerCase() === account.toLowerCase();
        const playerTwo = account && player2.toLowerCase() === account.toLowerCase();
        const isParticipant = Boolean(playerOne || playerTwo);

        setJoinGameId(targetGameId);
        storeLastGameId(targetGameId);

        if (!isParticipant && stateNumber === 0 && !hasPlayer2) {
          setCurrentGameId('');
          setGameState(null);
          setPhase('idle');
          if (!silent) {
            setSuccess(`Game #${targetGameId} is open. Choose your move and secret, then join it.`);
          }
          return true;
        }

        setCurrentGameId(targetGameId);

        const savedCommitment = readPlayerCommitment(targetGameId, account);
        if (savedCommitment) {
          setSelectedMove(savedCommitment.move);
          setSecret(savedCommitment.secret);
          setCommitHash(await generateCommitHash(savedCommitment.move, savedCommitment.secret));
        } else {
          setSelectedMove(null);
          setSecret('');
          setCommitHash('');
        }

        await checkGameState(targetGameId);

        if (!silent && stateNumber !== 3) {
          if (isParticipant && savedCommitment) {
            setSuccess(`Loaded game #${targetGameId}. Your saved move and secret are ready to reveal.`);
          } else if (isParticipant) {
            setSuccess(`Loaded game #${targetGameId}. Re-enter your original move and secret to reveal.`);
          } else {
            setSuccess(`Game #${targetGameId} is already full. Loaded it as a watcher.`);
          }
        }

        return true;
      } catch (loadError) {
        if (!silent) {
          setError(`Could not load game #${targetGameId}: ${getReadableError(loadError)}`);
        }
        return false;
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [account, checkGameState, contract, generateCommitHash, joinGameId]
  );

  const joinGame = useCallback(async () => {
    const targetGameId = joinGameId.trim();

    if (!contract || !selectedMove || !secret.trim()) {
      setError('Select a move, enter a secret phrase, and provide a game ID.');
      return;
    }

    if (!/^\d+$/.test(targetGameId)) {
      setError('Enter a valid numeric game ID.');
      return;
    }

    setLoading(true);
    setError('');
    setSuccess('');

    try {
      const info = await contract.getGameInfo(targetGameId);
      const [player1, player2, requiredBet, state] = info;
      const stateNumber = Number(state);
      const hasPlayer2 = !isZeroAddress(player2);
      const playerOne = account && player1.toLowerCase() === account.toLowerCase();
      const playerTwo = account && player2.toLowerCase() === account.toLowerCase();

      if (playerOne || playerTwo) {
        await loadGame(targetGameId);
        return;
      }

      if (stateNumber !== 0 || hasPlayer2) {
        setJoinGameId(targetGameId);
        storeLastGameId(targetGameId);
        setError(`Game #${targetGameId} is not open. It may already have two players or be finished.`);
        return;
      }

      const hash = await generateCommitHash(selectedMove, secret);

      setCommitHash(hash);

      const transaction = await contract.joinGame(targetGameId, hash, { value: requiredBet });
      await transaction.wait();

      setCurrentGameId(targetGameId);
      storeLastGameId(targetGameId);
      storePlayerCommitment(targetGameId, account, selectedMove, secret);
      setIsPlayer1(false);
      setIsPlayer2(true);
      setPhase('reveal');
      setSuccess(`Joined game #${targetGameId}. Reveal when you are ready.`);

      await Promise.all([checkGameState(targetGameId), refreshBalance()]);
    } catch (joinError) {
      setError(`Failed to join game: ${getReadableError(joinError)}`);
    } finally {
      setLoading(false);
    }
  }, [
    checkGameState,
    contract,
    generateCommitHash,
    account,
    joinGameId,
    loadGame,
    refreshBalance,
    secret,
    selectedMove
  ]);

  const revealMove = useCallback(async () => {
    if (!contract || !currentGameId || !selectedMove || !secret.trim()) {
      setError('Missing move, secret phrase, or game ID.');
      return;
    }

    setLoading(true);
    setError('');
    setSuccess('');

    try {
      const transaction = await contract.revealMove(currentGameId, selectedMove, secret);
      await transaction.wait();

      setSuccess('Move revealed. Waiting for the other reveal.');

      await Promise.all([checkGameState(currentGameId), refreshBalance()]);
    } catch (revealError) {
      setError(`Failed to reveal move: ${getReadableError(revealError)}`);
    } finally {
      setLoading(false);
    }
  }, [checkGameState, contract, currentGameId, refreshBalance, secret, selectedMove]);

  const claimTimeout = useCallback(
    async (type) => {
      if (!contract || !currentGameId) return;

      setLoading(true);
      setError('');
      setSuccess('');

      try {
        const transaction =
          type === 'commit'
            ? await contract.claimCommitTimeout(currentGameId)
            : await contract.claimRevealTimeout(currentGameId);

        await transaction.wait();

        await refreshBalance();
        resetGame();
        setSuccess('Timeout claimed.');
      } catch (timeoutError) {
        setError(`Timeout claim failed: ${getReadableError(timeoutError)}`);
      } finally {
        setLoading(false);
      }
    },
    [contract, currentGameId, refreshBalance, resetGame]
  );

  const copyGameId = useCallback(
    async (gameIdToCopy) => {
      const id =
        typeof gameIdToCopy === 'string'
          ? gameIdToCopy
          : currentGameId || joinGameId || readLastGameId();

      if (!id) return;

      setJoinGameId(id);
      storeLastGameId(id);

      try {
        await navigator.clipboard.writeText(id);
        setSuccess(`Copied game ID #${id}. Paste ${id} into the Join Game field.`);
      } catch {
        setSuccess(`Game ID: ${id}`);
      }
    },
    [currentGameId, joinGameId]
  );

  useEffect(() => {
    if (!window.ethereum) return undefined;

    const handleAccountsChanged = (accounts) => {
      const savedGameId = currentGameId || joinGameId || readLastGameId();

      if (!accounts.length) {
        setProvider(null);
        setContract(null);
        setAccount('');
        setBalance('0');
        setIsConnected(false);
        resetGame();
        return;
      }

      resetGame();
      if (savedGameId) {
        setJoinGameId(savedGameId);
        storeLastGameId(savedGameId);
      }

      connectWallet();
    };

    const handleChainChanged = () => {
      connectWallet();
    };

    window.ethereum.on('accountsChanged', handleAccountsChanged);
    window.ethereum.on('chainChanged', handleChainChanged);

    return () => {
      window.ethereum.removeListener('accountsChanged', handleAccountsChanged);
      window.ethereum.removeListener('chainChanged', handleChainChanged);
    };
  }, [connectWallet, currentGameId, joinGameId, resetGame]);

  useEffect(() => {
    if (!contract || !account || currentGameId || !joinGameId) return undefined;

    let cancelled = false;

    const loadSavedParticipantGame = async () => {
      try {
        const info = await contract.getGameInfo(joinGameId);
        if (cancelled) return;

        const [player1, player2] = info;
        const playerOne = player1.toLowerCase() === account.toLowerCase();
        const playerTwo = !isZeroAddress(player2) && player2.toLowerCase() === account.toLowerCase();

        if (playerOne || playerTwo) {
          await loadGame(joinGameId, { silent: true });
        }
      } catch {
        // Stale saved game IDs are harmless; the player can type a new one.
      }
    };

    loadSavedParticipantGame();

    return () => {
      cancelled = true;
    };
  }, [account, contract, currentGameId, joinGameId, loadGame]);

  useEffect(() => {
    if (!provider) return undefined;

    let isMounted = true;

    const updateBlockNumber = async () => {
      try {
        const nextBlock = await provider.getBlockNumber();
        if (isMounted) setBlockNumber(nextBlock);
      } catch {
        // A temporary RPC miss should not interrupt the game flow.
      }
    };

    updateBlockNumber();
    const intervalId = setInterval(updateBlockNumber, 5000);

    return () => {
      isMounted = false;
      clearInterval(intervalId);
    };
  }, [provider]);

  useEffect(() => {
    if (!contract || !currentGameId) return undefined;

    checkGameState(currentGameId);
    const intervalId = setInterval(() => checkGameState(currentGameId), 3000);

    return () => clearInterval(intervalId);
  }, [checkGameState, contract, currentGameId]);

  useEffect(() => {
    if (!contract || !currentGameId) return undefined;

    const isCurrentGame = (gameId) => gameId.toString() === currentGameId.toString();

    const handleJoined = (gameId) => {
      if (!isCurrentGame(gameId)) return;
      setSuccess('Opponent joined. Reveal your move.');
      checkGameState(currentGameId);
    };

    const handleReveal = (gameId, player, move) => {
      if (!isCurrentGame(gameId)) return;
      const playerLabel = player.toLowerCase() === account.toLowerCase() ? 'Your' : 'Opponent';
      setSuccess(`${playerLabel} ${getMoveDetails(move).name} revealed.`);
      checkGameState(currentGameId);
    };

    const handleResolved = async (gameId, winner, payout) => {
      if (!isCurrentGame(gameId)) return;
      setPhase('resolve');
      await markGameResolved(gameId, winner, payout);
      checkGameState(currentGameId);
      refreshBalance();
    };

    const handleCancelled = (gameId, caller, reason) => {
      if (!isCurrentGame(gameId)) return;
      setPhase('resolve');
      setSuccess(`Game cancelled: ${reason || 'timeout'}.`);
      checkGameState(currentGameId);
      refreshBalance();
    };

    contract.on('PlayerJoined', handleJoined);
    contract.on('MoveRevealed', handleReveal);
    contract.on('GameResolved', handleResolved);
    contract.on('GameCancelled', handleCancelled);

    return () => {
      contract.off('PlayerJoined', handleJoined);
      contract.off('MoveRevealed', handleReveal);
      contract.off('GameResolved', handleResolved);
      contract.off('GameCancelled', handleCancelled);
    };
  }, [account, checkGameState, contract, currentGameId, markGameResolved, refreshBalance]);

  const phaseIndex = useMemo(() => {
    if (phase === 'reveal') return 1;
    if (phase === 'resolve') return 2;
    return 0;
  }, [phase]);

  const hasOpponent = gameState ? !isZeroAddress(isPlayer2 ? gameState.player1 : gameState.player2) : false;
  const opponentAddress = gameState ? (isPlayer2 ? gameState.player1 : gameState.player2) : ZERO_ADDRESS;
  const playerHasRevealed = Boolean(
    gameState && ((isPlayer1 && gameState.player1Revealed) || (isPlayer2 && gameState.player2Revealed))
  );
  const opponentHasRevealed = Boolean(
    gameState && ((isPlayer1 && gameState.player2Revealed) || (isPlayer2 && gameState.player1Revealed))
  );
  const commitTimeoutClaimable = Boolean(
    gameState && gameState.state === 0 && blockNumber > gameState.commitDeadline
  );
  const revealTimeoutClaimable = Boolean(
    gameState && [1, 2].includes(gameState.state) && blockNumber > gameState.revealDeadline
  );
  const totalPot = gameState ? (Number(gameState.betAmount) * 2).toFixed(4) : '0.0000';
  const lockMoveAndSecretInputs = Boolean(currentGameId) && phase !== 'reveal' && phase !== 'resolve';
  const lockBetInput = Boolean(currentGameId);
  const isParticipant = isPlayer1 || isPlayer2;
  const canReveal = phase === 'reveal' && isParticipant && !playerHasRevealed && selectedMove && secret.trim();

  const MoveButton = ({ move }) => {
    const moveDetails = getMoveDetails(move.id);

    return (
      <button
        type="button"
        className={`move-btn ${selectedMove === move.id ? 'selected' : ''}`}
        onClick={() => setSelectedMove(move.id)}
        disabled={lockMoveAndSecretInputs || loading || playerHasRevealed}
        aria-pressed={selectedMove === move.id}
      >
        <span className="move-emoji">{moveDetails.emoji}</span>
        <span className="move-name">{moveDetails.name}</span>
        <span className="move-rule">{moveDetails.beats}</span>
      </button>
    );
  };

  return (
    <div className="app">
      <header className="header">
        <div className="logo" aria-label="ChainRPS">
          <span className="logo-icon">✊</span>
          <div>
            <h1>ChainRPS</h1>
            <p>Sepolia commit-reveal matches</p>
          </div>
        </div>

        <div className="wallet-info">
          {isConnected ? (
            <>
              <span className="network-badge">Sepolia</span>
              <span className="address-badge">{shortenAddress(account)}</span>
              <span className="balance">{Number(balance).toFixed(4)} ETH</span>
              <button className="logout-btn" type="button" onClick={disconnectWallet} disabled={loading}>
                Logout
              </button>
            </>
          ) : (
            <button className="connect-btn" type="button" onClick={connectWallet} disabled={loading}>
              {loading ? 'Connecting...' : 'Connect MetaMask'}
            </button>
          )}
        </div>
      </header>

      <main className="main">
        {!isConnected ? (
          <section className="connect-prompt">
            <div className="logo-icon-large">✊</div>
            <h2>ChainRPS</h2>
            <p>
              Decentralized Rock Paper Scissors on Ethereum Sepolia.
              Commit your move privately, reveal to win ETH.
            </p>

            <div className="features">
              <div className="feature-card">
                <div className="feature-icon">🔒</div>
                <div className="feature-title">Commit-Reveal</div>
                <div className="feature-desc">Cryptographic proof prevents cheating</div>
              </div>
              <div className="feature-card">
                <div className="feature-icon">💰</div>
                <div className="feature-title">Bet & Win</div>
                <div className="feature-desc">Stake ETH, winner takes the pot</div>
              </div>
              <div className="feature-card">
                <div className="feature-icon">⛓️</div>
                <div className="feature-title">Fully On-Chain</div>
                <div className="feature-desc">No server, no admin, pure smart contract</div>
              </div>
            </div>

            <button className="connect-btn large" type="button" onClick={connectWallet} disabled={loading}>
              {loading ? 'Connecting...' : 'Connect MetaMask'}
            </button>

            <div className="network-badge-landing">
              ⚡ Sepolia Testnet
            </div>
            {joinGameId && (
              <section className="game-strip saved-game">
                <div>
                  <span className="eyebrow">Saved game ID</span>
                  <strong>#{joinGameId}</strong>
                </div>
                <button className="ghost-btn" type="button" onClick={() => copyGameId(joinGameId)}>
                  Copy ID
                </button>
              </section>
            )}
            {error && <div className="alert error">{error}</div>}
            {success && <div className="alert success">{success}</div>}
          </section>
        ) : (
          <>
            <section className="phase-tracker" aria-label="Game phase">
              {PHASES.map((phaseName, index) => (
                <div
                  key={phaseName}
                  className={`phase ${phaseIndex === index ? 'active' : ''} ${phaseIndex > index ? 'complete' : ''}`}
                >
                  <span className="phase-num">{String(index + 1).padStart(2, '0')}</span>
                  <span className="phase-name">{phaseName}</span>
                </div>
              ))}
            </section>

            {currentGameId && (
              <section className="game-strip">
                <div>
                  <span className="eyebrow">Active game</span>
                  <strong>#{currentGameId}</strong>
                </div>
                <button className="ghost-btn" type="button" onClick={() => copyGameId(currentGameId)}>
                  Copy ID
                </button>
              </section>
            )}

            {!currentGameId && joinGameId && (
              <section className="game-strip saved-game">
                <div>
                  <span className="eyebrow">Saved game ID</span>
                  <strong>#{joinGameId}</strong>
                </div>
                <button className="ghost-btn" type="button" onClick={() => copyGameId(joinGameId)}>
                  Copy ID
                </button>
              </section>
            )}

            {currentGameId && gameState && (
              <section className="game-status">
                <div className="player-box">
                  <span className="player-label">You</span>
                  <span className="player-address">{shortenAddress(account)}</span>
                  <span className={`status-dot ${isPlayer1 ? 'p1' : 'p2'}`}>
                    {isPlayer1 ? 'Player 1' : isPlayer2 ? 'Player 2' : 'Watching'}
                  </span>
                </div>
                <div className="vs">VS</div>
                <div className="player-box">
                  <span className="player-label">Opponent</span>
                  <span className="player-address">{shortenAddress(opponentAddress)}</span>
                  <span className={`status-dot ${hasOpponent ? 'committed' : 'waiting'}`}>
                    {hasOpponent ? 'Committed' : 'Waiting'}
                  </span>
                </div>
              </section>
            )}

            {currentGameId && gameState && (
              <section className="pot-display">
                <span className="pot-label">Total pot</span>
                <span className="pot-amount">{totalPot} ETH</span>
                <span className="block-pill">
                  Block <strong>{blockNumber || '...'}</strong> · Winner gets 95%
                </span>
              </section>
            )}

            {error && <div className="alert error">{error}</div>}
            {success && <div className="alert success">{success}</div>}

            <section className="input-section">
              <div className="section-heading">
                <h3>Choose Your Move</h3>
                {commitHash && <span className="hash-pill">{shortenAddress(commitHash)}</span>}
              </div>
              <div className="moves-grid">
                {MOVES.map((move) => (
                  <MoveButton key={move.id} move={move} />
                ))}
              </div>
            </section>

            <section className="form-grid">
              <label className="field">
                <span>Secret phrase</span>
                <input
                  type="text"
                  value={secret}
                  onChange={(event) => setSecret(event.target.value)}
                  placeholder="Keep it private until reveal"
                  disabled={lockMoveAndSecretInputs || loading || playerHasRevealed}
                />
              </label>

              <label className="field">
                <span>Bet amount</span>
                <input
                  type="number"
                  value={betAmount}
                  onChange={(event) => setBetAmount(event.target.value)}
                  min="0.001"
                  step="0.001"
                  disabled={lockBetInput || loading}
                />
              </label>
            </section>

            <section className="actions">
              {phase === 'idle' && (
                <>
                  <button
                    className="action-btn primary"
                    type="button"
                    onClick={createGame}
                    disabled={!selectedMove || !secret.trim() || loading}
                  >
                    {loading ? 'Creating...' : `Create Game & Bet ${betAmount || '0'} ETH`}
                  </button>

                  <div className="or-divider">OR</div>

                  <div className="join-section">
                    <input
                      type="number"
                      placeholder="Game ID"
                      value={joinGameId}
                      onChange={(event) => setJoinGameId(event.target.value)}
                      disabled={loading}
                    />
                    <button
                      className="action-btn secondary"
                      type="button"
                      onClick={joinGame}
                      disabled={!selectedMove || !secret.trim() || !joinGameId.trim() || loading}
                    >
                      {loading ? 'Joining...' : 'Join Game'}
                    </button>
                    <button
                      className="action-btn tertiary"
                      type="button"
                      onClick={() => loadGame(joinGameId)}
                      disabled={!joinGameId.trim() || loading}
                    >
                      Load Game
                    </button>
                  </div>
                </>
              )}

              {phase === 'commit' && (
                <div className="waiting-msg">
                  <strong>Waiting for opponent to join...</strong>
                  <span>Share game #{currentGameId} with player 2.</span>
                  {commitTimeoutClaimable && (
                    <button className="timeout-btn" type="button" onClick={() => claimTimeout('commit')} disabled={loading}>
                      Claim Timeout
                    </button>
                  )}
                </div>
              )}

              {phase === 'reveal' && (
                <>
                  {!isParticipant ? (
                    <div className="waiting-msg">
                      <strong>This wallet is watching.</strong>
                      <span>Switch to player 1 or player 2 to reveal this game.</span>
                    </div>
                  ) : playerHasRevealed ? (
                    <div className="waiting-msg">
                      <strong>Your move is revealed.</strong>
                      <span>{opponentHasRevealed ? 'Resolving on-chain...' : 'Waiting for opponent reveal.'}</span>
                    </div>
                  ) : (
                    <button
                      className="action-btn primary"
                      type="button"
                      onClick={revealMove}
                      disabled={!canReveal || loading}
                    >
                      {loading ? 'Revealing...' : 'Reveal Move'}
                    </button>
                  )}

                  {revealTimeoutClaimable && (
                    <button className="timeout-btn" type="button" onClick={() => claimTimeout('reveal')} disabled={loading}>
                      Claim Reveal Timeout
                    </button>
                  )}
                </>
              )}

              {phase === 'resolve' && (
                <button className="action-btn primary" type="button" onClick={resetGame}>
                  Play Again
                </button>
              )}
            </section>

            <section className="win-streak">
              <div className="streak-emblem" aria-hidden="true" />
              <div className="streak-info">
                <span className="streak-count">{winStreak}</span>
                <span className="streak-label">Win streak</span>
              </div>
              <div className="streak-progress">
                <span className="nft-badge">
                  {winStreak >= 3 ? 'NFT ready' : `${3 - winStreak} more to mint NFT`}
                </span>
                <span className="streak-meter" aria-hidden="true">
                  <span style={{ width: `${Math.min(winStreak, 3) * 33.333}%` }} />
                </span>
              </div>
            </section>

            <section className="recent-games">
              <div className="section-heading">
                <h3>Recent Games</h3>
              </div>
              <div className="games-list">
                {recentGames.length === 0 ? (
                  <p className="no-games">No games yet</p>
                ) : (
                  recentGames.map((game) => {
                    const playerMove = getMoveDetails(game.playerMove);
                    const opponentMove = getMoveDetails(game.opponentMove);

                    return (
                      <article
                        key={`${game.id}-${game.timestamp}`}
                        className={`game-card ${game.isWin ? 'win' : game.isDraw ? 'draw' : 'loss'}`}
                      >
                        <div className="game-id">#{game.id}</div>
                        <div className="game-moves">
                          <span className="recent-move" title={playerMove.name}>
                            {playerMove.emoji}
                          </span>
                          <span className="vs-small">VS</span>
                          <span className="recent-move" title={opponentMove.name}>
                            {opponentMove.emoji}
                          </span>
                        </div>
                        <div className="game-result">{game.isWin ? 'Win' : game.isDraw ? 'Draw' : 'Loss'}</div>
                        <div className="game-payout">
                          {game.isWin ? `+${game.payout} ETH` : game.isDraw ? '\u00b10 ETH' : `-${game.betAmount} ETH`}
                        </div>
                        <time>{game.timestamp}</time>
                      </article>
                    );
                  })
                )}
              </div>
            </section>
          </>
        )}
      </main>
    </div>
  );
}

export default App;
