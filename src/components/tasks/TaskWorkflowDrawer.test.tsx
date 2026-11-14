import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TaskWorkflowDrawer } from './TaskWorkflowDrawer';
import type { MonitorStatus, TelemetryData, WorkflowExecutionResponse } from '@/lib/core/types';

const mockMonitorStatus: MonitorStatus = {
  status: 'healthy',
  cpu_pct: 1.8,
  memory_rss_mb: 112.5,
  temperature_c: 44.2,
  load_1m: 0.15,
  active_tasks: [
    {
      id: 'task_1',
      name: 'Cognitive Memory Consolidation',
      status: 'running',
      progress: 60,
      details: 'Indexing vector memory nodes and maintaining RRF graph',
    },
  ],
  scheduled_timers: [
    {
      id: 'timer_1',
      name: 'Temperature Watchdog',
      schedule: '*/15 * * * *',
      next_run: '2026-11-14 22:00:00',
      enabled: true,
    },
  ],
  pending_approvals: [
    {
      id: 'appr_1',
      action_hash: 'hash_abc',
      tool_name: 'shell_run',
      arguments: { cmd: 'systemctl restart potaeto-core' },
      status: 'pending',
      expires_at: 1731612000,
      created_at: 1731611700,
    },
  ],
  uptime_seconds: 4800,
};

const mockTelemetry: TelemetryData = {
  connected: true,
  temperature: 24.5,
  humidity: 50.2,
  pressure: 1013.25,
  light: 340,
  accelerometer: [0.01, -0.02, 9.8],
  ok: true,
};

const mockWorkflowResponse: WorkflowExecutionResponse = {
  workflow: 'morning-briefing',
  status: 'completed',
  summary: 'Good morning! System vitals nominal. 5 memories, 1 approval pending.',
  timestamp: '2026-11-14T10:00:00Z',
  data: {
    briefing: 'Good morning! System vitals nominal.',
  },
};

const mocks = vi.hoisted(() => ({
  getMonitorStatus: vi.fn(),
  getTelemetry: vi.fn(),
  executeWorkflow: vi.fn(),
  resolveApproval: vi.fn(),
}));

vi.mock('@/components/providers/CoreProvider', () => ({
  useCore: () => ({
    client: {
      getMonitorStatus: mocks.getMonitorStatus,
      getTelemetry: mocks.getTelemetry,
      executeWorkflow: mocks.executeWorkflow,
      resolveApproval: mocks.resolveApproval,
    },
    online: true,
  }),
  coreBaseUrl: () => '',
}));

beforeEach(() => {
  mocks.getMonitorStatus.mockReset();
  mocks.getTelemetry.mockReset();
  mocks.executeWorkflow.mockReset();
  mocks.resolveApproval.mockReset();

  mocks.getMonitorStatus.mockResolvedValue(mockMonitorStatus);
  mocks.getTelemetry.mockResolvedValue(mockTelemetry);
  mocks.executeWorkflow.mockResolvedValue(mockWorkflowResponse);
  mocks.resolveApproval.mockResolvedValue({ id: 'appr_1', status: 'approved' });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('TaskWorkflowDrawer (Modern Web Guidance Navigation Drawer)', () => {
  it('renders top-layer dialog with accessible aria-label="Potaeto Executive Center"', async () => {
    const handleClose = vi.fn();
    render(<TaskWorkflowDrawer isOpen={true} onClose={handleClose} pollIntervalMs={60000} />);

    const dialog = screen.getByRole('dialog', { name: /potaeto executive center/i });
    expect(dialog).toBeInTheDocument();
    expect(dialog).toHaveAttribute('aria-label', 'Potaeto Executive Center');

    const closeBtn = screen.getByRole('button', { name: /close executive center/i });
    expect(closeBtn).toBeInTheDocument();
  });

  it('does not render when isOpen is false', () => {
    const handleClose = vi.fn();
    render(<TaskWorkflowDrawer isOpen={false} onClose={handleClose} />);

    expect(screen.queryByRole('dialog', { name: /potaeto executive center/i })).not.toBeInTheDocument();
  });

  it('displays live server CPU, memory RSS, temperature, active tasks, timers, and approvals on Tab 1', async () => {
    render(<TaskWorkflowDrawer isOpen={true} onClose={vi.fn()} pollIntervalMs={60000} />);

    // Vitals
    await waitFor(() => {
      expect(screen.getByTestId('cpu-stat')).toHaveTextContent('1.8%');
      expect(screen.getByTestId('memory-stat')).toHaveTextContent('112.5 MB');
      expect(screen.getByTestId('temp-stat')).toHaveTextContent('44.2°C');
    });

    // Active Task
    expect(screen.getByText('Cognitive Memory Consolidation')).toBeInTheDocument();
    expect(screen.getByText('60%')).toBeInTheDocument();

    // Scheduled Timer
    expect(screen.getByText('Temperature Watchdog')).toBeInTheDocument();
    expect(screen.getByText(/Schedule: \*\//)).toBeInTheDocument();

    // Pending Approval
    expect(screen.getByText(/shell_run/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /approve/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /reject/i })).toBeInTheDocument();

    // Telemetry
    expect(screen.getByText(/Arduino BLE Telemetry/i)).toBeInTheDocument();
    expect(screen.getByText('24.5°C')).toBeInTheDocument();
    expect(screen.getByText('50.2%')).toBeInTheDocument();
  });

  it('allows approving or rejecting pending tool approval from inside the drawer', async () => {
    render(<TaskWorkflowDrawer isOpen={true} onClose={vi.fn()} pollIntervalMs={60000} />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /approve/i })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /approve/i }));

    await waitFor(() => {
      expect(mocks.resolveApproval).toHaveBeenCalledWith('appr_1', 'approved');
    });
  });

  it('switches to Workflow Launcher Tab and renders all 5 triggers', async () => {
    render(<TaskWorkflowDrawer isOpen={true} onClose={vi.fn()} pollIntervalMs={60000} />);

    const workflowsTab = screen.getByTestId('tab-workflows');
    fireEvent.click(workflowsTab);

    expect(screen.getByTestId('workflows-tab-content')).toBeInTheDocument();

    expect(screen.getByText('Morning Briefing')).toBeInTheDocument();
    expect(screen.getByText('Memory Consolidation')).toBeInTheDocument();
    expect(screen.getByText('Research Drill')).toBeInTheDocument();
    expect(screen.getByText('Hardware Sweep')).toBeInTheDocument();
    expect(screen.getByText('Backup Snapshot')).toBeInTheDocument();

    expect(screen.getByTestId('workflow-btn-morning-briefing')).toBeInTheDocument();
    expect(screen.getByTestId('workflow-btn-memory-consolidation')).toBeInTheDocument();
    expect(screen.getByTestId('workflow-btn-research-drill')).toBeInTheDocument();
    expect(screen.getByTestId('workflow-btn-hardware-sweep')).toBeInTheDocument();
    expect(screen.getByTestId('workflow-btn-backup-snapshot')).toBeInTheDocument();
  });

  it('executes a workflow and shows real-time execution feedback and summary', async () => {
    render(<TaskWorkflowDrawer isOpen={true} onClose={vi.fn()} pollIntervalMs={60000} />);

    // Switch to workflows
    fireEvent.click(screen.getByTestId('tab-workflows'));

    const runBtn = screen.getByTestId('workflow-btn-morning-briefing');
    fireEvent.click(runBtn);

    expect(mocks.executeWorkflow).toHaveBeenCalledWith('morning-briefing');

    await waitFor(() => {
      expect(screen.getByTestId('workflow-result-morning-briefing')).toBeInTheDocument();
      expect(screen.getByText(/Good morning! System vitals nominal/i)).toBeInTheDocument();
    });
  });

  it('calls onClose when close button is clicked or Escape is pressed', async () => {
    const handleClose = vi.fn();
    render(<TaskWorkflowDrawer isOpen={true} onClose={handleClose} pollIntervalMs={60000} />);

    const closeBtn = screen.getByTestId('drawer-close-btn');
    fireEvent.click(closeBtn);
    expect(handleClose).toHaveBeenCalledTimes(1);

    const dialog = screen.getByRole('dialog', { name: /potaeto executive center/i });
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(handleClose).toHaveBeenCalledTimes(2);

    fireEvent(dialog, new Event('cancel'));
    expect(handleClose).toHaveBeenCalledTimes(3);
  });

  it('calls onClose on backdrop click (outside sheet)', () => {
    const handleClose = vi.fn();
    render(<TaskWorkflowDrawer isOpen={true} onClose={handleClose} pollIntervalMs={60000} />);

    const dialog = screen.getByRole('dialog', { name: /potaeto executive center/i });
    // Click on dialog backdrop (not on the sheet)
    fireEvent.click(dialog);
    expect(handleClose).toHaveBeenCalledTimes(1);
  });
});
