// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

contract RockPaperScissors is ReentrancyGuard {
    enum GameState {
        Open,
        Joined,
        Revealing,
        Resolved,
        Cancelled
    }

    struct Game {
        address player1;
        address player2;
        bytes32 player1Commit;
        bytes32 player2Commit;
        uint8 player1Move;
        uint8 player2Move;
        uint256 betAmount;
        GameState state;
        uint256 commitDeadline;
        uint256 revealDeadline;
        address winner;
        bool player1Revealed;
        bool player2Revealed;
    }

    uint8 private constant ROCK = 1;
    uint8 private constant PAPER = 2;
    uint8 private constant SCISSORS = 3;
    uint256 private constant COMMIT_TIMEOUT_BLOCKS = 50;
    uint256 private constant REVEAL_TIMEOUT_BLOCKS = 50;

    uint256 public nextGameId;
    uint256 public houseFeePercent = 5;
    uint256 public houseBalance;
    address public owner;

    mapping(uint256 => Game) public games;

    event GameCreated(uint256 indexed gameId, address indexed player1, uint256 betAmount);
    event PlayerJoined(uint256 indexed gameId, address indexed player2);
    event MoveRevealed(uint256 indexed gameId, address indexed player, uint8 move);
    event GameResolved(uint256 indexed gameId, address indexed winner, uint256 payout);
    event GameCancelled(uint256 indexed gameId, address indexed caller, string reason);

    modifier onlyOwner() {
        require(msg.sender == owner, "Not owner");
        _;
    }

    constructor() {
        owner = msg.sender;
    }

    function createGame(bytes32 _commitHash) external payable nonReentrant returns (uint256) {
        require(msg.value > 0, "Bet required");
        require(_commitHash != bytes32(0), "Commit required");

        uint256 gameId = nextGameId;
        nextGameId += 1;

        games[gameId] = Game({
            player1: msg.sender,
            player2: address(0),
            player1Commit: _commitHash,
            player2Commit: bytes32(0),
            player1Move: 0,
            player2Move: 0,
            betAmount: msg.value,
            state: GameState.Open,
            commitDeadline: block.number + COMMIT_TIMEOUT_BLOCKS,
            revealDeadline: 0,
            winner: address(0),
            player1Revealed: false,
            player2Revealed: false
        });

        emit GameCreated(gameId, msg.sender, msg.value);
        return gameId;
    }

    function joinGame(uint256 _gameId, bytes32 _commitHash) external payable nonReentrant {
        Game storage game = games[_gameId];

        require(game.player1 != address(0), "Game missing");
        require(game.state == GameState.Open, "Not open");
        require(block.number <= game.commitDeadline, "Commit timeout");
        require(msg.sender != game.player1, "No self-play");
        require(msg.value == game.betAmount, "Bet mismatch");
        require(_commitHash != bytes32(0), "Commit required");

        game.player2 = msg.sender;
        game.player2Commit = _commitHash;
        game.state = GameState.Joined;
        game.revealDeadline = block.number + REVEAL_TIMEOUT_BLOCKS;

        emit PlayerJoined(_gameId, msg.sender);
    }

    function revealMove(uint256 _gameId, uint8 _move, string memory _secret) external nonReentrant {
        Game storage game = games[_gameId];

        require(game.state == GameState.Joined || game.state == GameState.Revealing, "Not reveal phase");
        require(block.number <= game.revealDeadline, "Reveal timeout");
        require(_isValidMove(_move), "Invalid move");

        if (msg.sender == game.player1) {
            require(!game.player1Revealed, "Already revealed");
            require(getCommitHash(_move, _secret) == game.player1Commit, "Invalid reveal");
            game.player1Move = _move;
            game.player1Revealed = true;
        } else if (msg.sender == game.player2) {
            require(!game.player2Revealed, "Already revealed");
            require(getCommitHash(_move, _secret) == game.player2Commit, "Invalid reveal");
            game.player2Move = _move;
            game.player2Revealed = true;
        } else {
            revert("Not a player");
        }

        emit MoveRevealed(_gameId, msg.sender, _move);

        if (game.player1Revealed && game.player2Revealed) {
            _resolveGame(_gameId, game);
        } else {
            game.state = GameState.Revealing;
        }
    }

    function claimCommitTimeout(uint256 _gameId) external nonReentrant {
        Game storage game = games[_gameId];

        require(game.player1 != address(0), "Game missing");
        require(game.state == GameState.Open, "Not open");
        require(block.number > game.commitDeadline, "Commit active");

        uint256 refund = game.betAmount;
        game.state = GameState.Cancelled;

        _sendValue(game.player1, refund);
        emit GameCancelled(_gameId, msg.sender, "Commit timeout");
    }

    function claimRevealTimeout(uint256 _gameId) external nonReentrant {
        Game storage game = games[_gameId];

        require(game.state == GameState.Joined || game.state == GameState.Revealing, "Not reveal phase");
        require(block.number > game.revealDeadline, "Reveal active");

        if (game.player1Revealed && !game.player2Revealed) {
            _payWinner(_gameId, game, game.player1);
        } else if (game.player2Revealed && !game.player1Revealed) {
            _payWinner(_gameId, game, game.player2);
        } else {
            uint256 refund = game.betAmount;
            game.state = GameState.Cancelled;

            _sendValue(game.player1, refund);
            _sendValue(game.player2, refund);
            emit GameCancelled(_gameId, msg.sender, "Reveal timeout");
        }
    }

    function getCommitHash(uint8 _move, string memory _secret) public pure returns (bytes32) {
        return keccak256(abi.encode(_move, _secret));
    }

    function getGameInfo(
        uint256 _gameId
    )
        external
        view
        returns (
            address,
            address,
            uint256,
            uint8,
            uint256,
            uint256,
            address,
            bool,
            bool
        )
    {
        Game storage game = games[_gameId];

        return (
            game.player1,
            game.player2,
            game.betAmount,
            uint8(game.state),
            game.commitDeadline,
            game.revealDeadline,
            game.winner,
            game.player1Revealed,
            game.player2Revealed
        );
    }

    function setHouseFeePercent(uint256 _houseFeePercent) external onlyOwner {
        require(_houseFeePercent <= 10, "Fee too high");
        houseFeePercent = _houseFeePercent;
    }

    function withdrawFees(address payable _to) external onlyOwner nonReentrant {
        require(_to != address(0), "Invalid recipient");

        uint256 amount = houseBalance;
        houseBalance = 0;
        _sendValue(_to, amount);
    }

    function _resolveGame(uint256 _gameId, Game storage game) private {
        game.state = GameState.Resolved;

        if (game.player1Move == game.player2Move) {
            uint256 refund = game.betAmount;

            _sendValue(game.player1, refund);
            _sendValue(game.player2, refund);
            emit GameResolved(_gameId, address(0), 0);
            return;
        }

        address winner = _player1Wins(game.player1Move, game.player2Move) ? game.player1 : game.player2;
        _payWinner(_gameId, game, winner);
    }

    function _payWinner(uint256 _gameId, Game storage game, address winner) private {
        uint256 pot = game.betAmount * 2;
        uint256 fee = (pot * houseFeePercent) / 100;
        uint256 payout = pot - fee;

        game.state = GameState.Resolved;
        game.winner = winner;
        houseBalance += fee;

        _sendValue(winner, payout);
        emit GameResolved(_gameId, winner, payout);
    }

    function _player1Wins(uint8 player1Move, uint8 player2Move) private pure returns (bool) {
        return
            (player1Move == ROCK && player2Move == SCISSORS) ||
            (player1Move == PAPER && player2Move == ROCK) ||
            (player1Move == SCISSORS && player2Move == PAPER);
    }

    function _isValidMove(uint8 move) private pure returns (bool) {
        return move == ROCK || move == PAPER || move == SCISSORS;
    }

    function _sendValue(address recipient, uint256 amount) private {
        if (amount == 0) return;

        (bool sent, ) = payable(recipient).call{ value: amount }("");
        require(sent, "Transfer failed");
    }
}
