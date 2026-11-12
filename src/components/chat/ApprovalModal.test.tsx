import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { ApprovalModal } from './ApprovalModal';

afterEach(() => {
  cleanup();
});

describe('ApprovalModal component', () => {
  const defaultApproval = {
    id: 'appr_123',
    tool_name: 'run_command',
    arguments: { command: 'echo hello', timeout: 30 },
  };

  it('renders tool name, arguments, warning banner, and buttons', () => {
    render(<ApprovalModal approval={defaultApproval} onResolve={vi.fn()} />);

    expect(screen.getByText('Action Approval Required')).toBeInTheDocument();
    expect(
      screen.getByText('This action requires your confirmation before proceeding.')
    ).toBeInTheDocument();
    expect(screen.getByText('run_command')).toBeInTheDocument();
    expect(screen.getByText(/echo hello/)).toBeInTheDocument();

    expect(screen.getByRole('button', { name: /approve/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /reject/i })).toBeInTheDocument();
  });

  it('calls onResolve with approved when Approve is clicked', async () => {
    const onResolve = vi.fn().mockResolvedValue(undefined);
    render(<ApprovalModal approval={defaultApproval} onResolve={onResolve} />);

    fireEvent.click(screen.getByRole('button', { name: /approve/i }));
    expect(onResolve).toHaveBeenCalledWith('approved');
  });

  it('calls onResolve with rejected when Reject is clicked', async () => {
    const onResolve = vi.fn().mockResolvedValue(undefined);
    render(<ApprovalModal approval={defaultApproval} onResolve={onResolve} />);

    fireEvent.click(screen.getByRole('button', { name: /reject/i }));
    expect(onResolve).toHaveBeenCalledWith('rejected');
  });

  it('shows countdown timer when expires_at is present', () => {
    const futureExpires = Date.now() / 1000 + 60;
    render(
      <ApprovalModal
        approval={{ ...defaultApproval, expires_at: futureExpires }}
        onResolve={vi.fn()}
      />
    );

    expect(screen.getByText(/Expires in \d+s/)).toBeInTheDocument();
  });

  it('disables buttons during loading', () => {
    render(<ApprovalModal approval={defaultApproval} onResolve={vi.fn()} loading={true} />);

    expect(screen.getByRole('button', { name: /approving\.\.\./i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /rejecting\.\.\./i })).toBeDisabled();
  });
});
