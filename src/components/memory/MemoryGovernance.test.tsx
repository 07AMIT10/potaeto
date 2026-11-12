import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryGovernance } from './MemoryGovernance';
import type { MemoryItem } from '@/lib/core/types';

const mockMemories: MemoryItem[] = [
  {
    id: 'mem_1',
    userId: 'u1',
    entityId: null,
    kind: 'fact',
    content: 'User prefers Neovim',
    source: 'user',
    sourceRef: null,
    confidence: 0.9,
    sensitivity: 'normal',
    scope: 'project:Anveshak',
    status: 'active',
    validFrom: null,
    validTo: null,
    supersedes: null,
    userConfirmed: true,
    createdAt: '2026-11-13T00:00:00Z',
    updatedAt: '2026-11-13T00:00:00Z',
  },
  {
    id: 'mem_2',
    userId: 'u1',
    entityId: null,
    kind: 'fact',
    content: 'Candidate web fact about weather',
    source: 'web',
    sourceRef: null,
    confidence: 0.5,
    sensitivity: 'normal',
    scope: 'global',
    status: 'active',
    validFrom: null,
    validTo: null,
    supersedes: null,
    userConfirmed: false,
    createdAt: '2026-11-13T01:00:00Z',
    updatedAt: '2026-11-13T01:00:00Z',
  },
];

const mocks = vi.hoisted(() => ({
  getMemories: vi.fn(),
  retractMemory: vi.fn(),
  supersedeMemory: vi.fn(),
  confirmMemory: vi.fn(),
}));

vi.mock('@/components/providers/CoreProvider', () => ({
  useCore: () => ({
    client: {
      getMemories: mocks.getMemories,
      retractMemory: mocks.retractMemory,
      supersedeMemory: mocks.supersedeMemory,
      confirmMemory: mocks.confirmMemory,
    },
    online: true,
  }),
}));

beforeEach(() => {
  mocks.getMemories.mockReset();
  mocks.retractMemory.mockReset();
  mocks.supersedeMemory.mockReset();
  mocks.confirmMemory.mockReset();

  mocks.getMemories.mockResolvedValue([...mockMemories]);
  mocks.retractMemory.mockResolvedValue(undefined);
  mocks.supersedeMemory.mockResolvedValue(undefined);
  mocks.confirmMemory.mockResolvedValue(undefined);

  vi.stubGlobal('confirm', vi.fn().mockReturnValue(true));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('MemoryGovernance', () => {
  it('renders memories with badges and actions', async () => {
    render(<MemoryGovernance />);

    await waitFor(() => {
      expect(screen.getByText('User prefers Neovim')).toBeInTheDocument();
      expect(screen.getByText('Candidate web fact about weather')).toBeInTheDocument();
    });

    expect(screen.getByText('Confirmed')).toBeInTheDocument();
    expect(screen.getByText('Candidate')).toBeInTheDocument();
    expect(screen.getByText('project:Anveshak')).toBeInTheDocument();
  });

  it('filters memories by tab', async () => {
    render(<MemoryGovernance />);

    await waitFor(() => {
      expect(mocks.getMemories).toHaveBeenCalledWith(undefined);
    });

    const activeTab = screen.getByRole('button', { name: /^active$/i });
    fireEvent.click(activeTab);

    await waitFor(() => {
      expect(mocks.getMemories).toHaveBeenCalledWith('active');
    });
  });

  it('retracts memory on button click', async () => {
    render(<MemoryGovernance />);

    await waitFor(() => {
      expect(screen.getByText('User prefers Neovim')).toBeInTheDocument();
    });

    const retractButtons = screen.getAllByRole('button', { name: /^retract$/i });
    fireEvent.click(retractButtons[0]);

    await waitFor(() => {
      expect(mocks.retractMemory).toHaveBeenCalledWith('mem_1');
    });
  });

  it('confirms candidate memory', async () => {
    render(<MemoryGovernance />);

    await waitFor(() => {
      expect(screen.getByText('Candidate web fact about weather')).toBeInTheDocument();
    });

    const confirmButton = screen.getByRole('button', { name: /^confirm$/i });
    fireEvent.click(confirmButton);

    await waitFor(() => {
      expect(mocks.confirmMemory).toHaveBeenCalledWith('mem_2');
    });
  });

  it('opens modal and supersedes memory', async () => {
    render(<MemoryGovernance />);

    await waitFor(() => {
      expect(screen.getByText('User prefers Neovim')).toBeInTheDocument();
    });

    const supersedeButtons = screen.getAllByRole('button', { name: /^supersede$/i });
    fireEvent.click(supersedeButtons[0]);

    // Modal opens
    expect(screen.getByText('Supersede Fact')).toBeInTheDocument();
    const textarea = screen.getByPlaceholderText(/enter the updated fact content/i);
    fireEvent.change(textarea, { target: { value: 'User prefers Emacs' } });

    const submitButton = screen.getByRole('button', { name: /confirm supersede/i });
    fireEvent.click(submitButton);

    await waitFor(() => {
      expect(mocks.supersedeMemory).toHaveBeenCalledWith('mem_1', 'User prefers Emacs');
    });
  });
});
