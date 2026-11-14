import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { LiveCaptions } from './LiveCaptions';

describe('LiveCaptions', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it('renders words correctly from speech text', () => {
    render(<LiveCaptions text="Hello from 3D Potaeto world" isStreaming={false} />);

    expect(screen.getByTestId('live-captions-text')).toHaveTextContent('Hello from 3D Potaeto world');
  });

  it('toggles spell-out speech preference and persists to localStorage', () => {
    render(<LiveCaptions text="Testing spell out preference" />);

    const toggleButton = screen.getByRole('button', { name: /toggle spell-out speech/i });
    expect(toggleButton).toHaveTextContent(/ON/);

    fireEvent.click(toggleButton);
    expect(toggleButton).toHaveTextContent(/OFF/);
    expect(localStorage.getItem('potaeto_spell_out')).toBe('false');

    fireEvent.click(toggleButton);
    expect(toggleButton).toHaveTextContent(/ON/);
    expect(localStorage.getItem('potaeto_spell_out')).toBe('true');
  });

  it('triggers copy on card click', async () => {
    const writeTextMock = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, {
      clipboard: {
        writeText: writeTextMock,
      },
    });

    render(<LiveCaptions text="Copy this message aloud" />);

    const copyBtn = screen.getByRole('button', { name: /copy captions text/i });
    fireEvent.click(copyBtn);

    expect(writeTextMock).toHaveBeenCalledWith('Copy this message aloud');
    expect(await screen.findByText(/copied to clipboard/i)).toBeInTheDocument();
  });

  it('triggers onOpenChat callback when full chat button is tapped', () => {
    const onOpenChat = vi.fn();
    render(<LiveCaptions text="Jump into chat" onOpenChat={onOpenChat} />);

    const openBtn = screen.getByRole('button', { name: /open full chat/i });
    fireEvent.click(openBtn);

    expect(onOpenChat).toHaveBeenCalledTimes(1);
  });
});
