import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { ConflictModal } from './ConflictModal';
import type { PushConflict } from '@/lib/core/types';

afterEach(cleanup);

describe('ConflictModal', () => {
  const sampleConflict: PushConflict = {
    idempotencyKey: 'op_123',
    entityType: 'persona',
    entityId: 'e_456',
    baseRev: 2,
    serverRev: 3,
    error: 'stale_rev',
    localPayload: { name: 'Local Persona', tone: 'friendly' },
  };

  it('renders nothing when conflict is null', () => {
    const { container } = render(
      <ConflictModal conflict={null} onResolve={vi.fn()} onClose={vi.fn()} />
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('renders conflict details when conflict is provided', () => {
    render(
      <ConflictModal conflict={sampleConflict} onResolve={vi.fn()} onClose={vi.fn()} />
    );
    expect(screen.getByText('Sync Conflict Detected')).toBeInTheDocument();
    expect(screen.getByText('persona')).toBeInTheDocument();
    expect(screen.getByText(/rev 3/)).toBeInTheDocument();
    expect(screen.getByText(/Local Persona/)).toBeInTheDocument();
  });

  it('calls onResolve with accept_server when Accept Server Version clicked', async () => {
    const onResolve = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();
    render(
      <ConflictModal conflict={sampleConflict} onResolve={onResolve} onClose={onClose} />
    );
    const btn = screen.getByRole('button', { name: /Accept Server Version/i });
    fireEvent.click(btn);
    expect(onResolve).toHaveBeenCalledWith('accept_server');
  });

  it('calls onResolve with keep_local when Keep My Version clicked', async () => {
    const onResolve = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();
    render(
      <ConflictModal conflict={sampleConflict} onResolve={onResolve} onClose={onClose} />
    );
    const btn = screen.getByRole('button', { name: /Keep My Version/i });
    fireEvent.click(btn);
    expect(onResolve).toHaveBeenCalledWith('keep_local');
  });
});
