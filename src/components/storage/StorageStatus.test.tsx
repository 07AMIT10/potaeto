import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StorageStatus } from './StorageStatus';
import * as persistenceModule from '@/lib/storage/persistence';

describe('StorageStatus Component', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('renders quota gauge with formatted usage, quota, and percentage', async () => {
    vi.spyOn(persistenceModule, 'checkStoragePersistence').mockResolvedValue(true);
    vi.spyOn(persistenceModule, 'getStorageQuota').mockResolvedValue({
      usage: 120 * 1024 * 1024,
      quota: 480 * 1024 * 1024,
      percentUsed: 25,
      formattedUsage: '120 MB',
      formattedQuota: '480 MB',
    });

    render(<StorageStatus />);

    await waitFor(() => {
      expect(screen.getByText('120 MB')).toBeInTheDocument();
      expect(screen.getByText('480 MB')).toBeInTheDocument();
      expect(screen.getByText('25% used')).toBeInTheDocument();
    });

    const progressbar = screen.getByRole('progressbar');
    expect(progressbar).toHaveAttribute('aria-valuenow', '25');
    expect(progressbar).toHaveAttribute('aria-valuemin', '0');
    expect(progressbar).toHaveAttribute('aria-valuemax', '100');
  });

  it('displays "Persistent Storage" badge when storage is persisted', async () => {
    vi.spyOn(persistenceModule, 'checkStoragePersistence').mockResolvedValue(true);
    vi.spyOn(persistenceModule, 'getStorageQuota').mockResolvedValue({
      usage: 50 * 1024 * 1024,
      quota: 500 * 1024 * 1024,
      percentUsed: 10,
      formattedUsage: '50 MB',
      formattedQuota: '500 MB',
    });

    render(<StorageStatus />);

    const badge = await screen.findByTestId('persistence-badge');
    expect(badge).toHaveTextContent(/Persistent Storage/i);
    expect(badge.className).toContain('emerald');
    // Button should not be present when already persisted
    expect(screen.queryByRole('button', { name: /Request Persistence/i })).not.toBeInTheDocument();
  });

  it('displays "Best-effort Storage" badge and "Request Persistence" button when not persisted', async () => {
    vi.spyOn(persistenceModule, 'checkStoragePersistence').mockResolvedValue(false);
    vi.spyOn(persistenceModule, 'getStorageQuota').mockResolvedValue({
      usage: 10 * 1024 * 1024,
      quota: 100 * 1024 * 1024,
      percentUsed: 10,
      formattedUsage: '10 MB',
      formattedQuota: '100 MB',
    });

    render(<StorageStatus />);

    const badge = await screen.findByTestId('persistence-badge');
    expect(badge).toHaveTextContent(/Best-effort Storage/i);
    expect(badge.className).toContain('amber');

    const button = screen.getByRole('button', { name: /Request Persistence/i });
    expect(button).toBeInTheDocument();
  });

  it('clicking "Request Persistence" calls requestStoragePersistence and updates badge', async () => {
    vi.spyOn(persistenceModule, 'checkStoragePersistence').mockResolvedValue(false);
    const requestMock = vi.spyOn(persistenceModule, 'requestStoragePersistence').mockResolvedValue(true);
    const quotaMock = vi.spyOn(persistenceModule, 'getStorageQuota').mockResolvedValue({
      usage: 10 * 1024 * 1024,
      quota: 100 * 1024 * 1024,
      percentUsed: 10,
      formattedUsage: '10 MB',
      formattedQuota: '100 MB',
    });

    render(<StorageStatus />);

    const button = await screen.findByRole('button', { name: /Request Persistence/i });
    fireEvent.click(button);

    await waitFor(() => {
      expect(requestMock).toHaveBeenCalledTimes(1);
    });

    const badge = await screen.findByTestId('persistence-badge');
    expect(badge).toHaveTextContent(/Persistent Storage/i);
    expect(screen.queryByRole('button', { name: /Request Persistence/i })).not.toBeInTheDocument();
  });
});
