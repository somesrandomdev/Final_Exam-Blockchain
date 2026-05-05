import { render, screen } from '@testing-library/react';
import App from './App';

beforeEach(() => {
  window.localStorage.clear();
});

test('renders ChainRPS connect prompt', () => {
  render(<App />);
  expect(screen.getByText(/ChainRPS/i)).toBeInTheDocument();
  expect(screen.getAllByRole('button', { name: /Connect MetaMask/i })).toHaveLength(2);
});

test('shows a saved game ID after refresh', () => {
  window.localStorage.setItem('chainrps:lastGameId', '7');
  render(<App />);
  expect(screen.getByText(/Saved game ID/i)).toBeInTheDocument();
  expect(screen.getByText('#7')).toBeInTheDocument();
});
