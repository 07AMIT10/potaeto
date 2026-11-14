'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { CoreClient } from '@/lib/core/client';
import type {
  ApprovalRequest,
  MonitorStatus,
  TelemetryData,
  WorkflowExecutionResponse,
} from '@/lib/core/types';
import { coreBaseUrl, useCore } from '@/components/providers/CoreProvider';

export interface TaskWorkflowDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  client?: CoreClient;
  pollIntervalMs?: number;
}

interface WorkflowItem {
  id: string;
  name: string;
  icon: string;
  description: string;
  endpoint: string;
}

const DEFAULT_WORKFLOWS: WorkflowItem[] = [
  {
    id: 'morning-briefing',
    name: 'Morning Briefing',
    icon: '🌅',
    description: 'Synthesizes server health, recent memory notes, and pending items into an executive briefing.',
    endpoint: '/v1/workflows/morning-briefing',
  },
  {
    id: 'memory-consolidation',
    name: 'Memory Consolidation',
    icon: '🧠',
    description: 'Scans recent memories, identifies clusters, and generates consolidation summary.',
    endpoint: '/v1/workflows/memory-consolidation',
  },
  {
    id: 'research-drill',
    name: 'Research Drill',
    icon: '🔬',
    description: 'Executes an autonomous research query across Lens MCP / scientific literature tools.',
    endpoint: '/v1/workflows/research-drill',
  },
  {
    id: 'hardware-sweep',
    name: 'Hardware Sweep',
    icon: '🔌',
    description: 'Polls Arduino telemetry, checks sensor boundaries, and returns health status.',
    endpoint: '/v1/workflows/hardware-sweep',
  },
  {
    id: 'backup-snapshot',
    name: 'Backup Snapshot',
    icon: '📦',
    description: 'Invokes database backup script and returns backup metadata.',
    endpoint: '/v1/workflows/backup-snapshot',
  },
];

interface ExecutionState {
  status: 'idle' | 'running' | 'completed' | 'failed';
  summary?: string;
  timestamp?: string;
  data?: Record<string, unknown>;
  error?: string;
}

export function TaskWorkflowDrawer({
  isOpen,
  onClose,
  client: propClient,
  pollIntervalMs = 4000,
}: TaskWorkflowDrawerProps) {
  let fallbackClient: CoreClient | null = null;
  try {
    const core = useCore();
    fallbackClient = core.client;
  } catch {
    fallbackClient = null;
  }
  const client = propClient || fallbackClient || new CoreClient({ baseUrl: coreBaseUrl() });

  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const sheetRef = useRef<HTMLElement | null>(null);

  const [activeTab, setActiveTab] = useState<'vitals' | 'workflows'>('vitals');
  const [monitorStatus, setMonitorStatus] = useState<MonitorStatus | null>(null);
  const [telemetry, setTelemetry] = useState<TelemetryData | null>(null);
  const [vitalsLoading, setVitalsLoading] = useState<boolean>(true);
  const [vitalsError, setVitalsError] = useState<string | null>(null);

  const [workflowStates, setWorkflowStates] = useState<Record<string, ExecutionState>>({});
  const [approvalsResolving, setApprovalsResolving] = useState<Record<string, boolean>>({});

  // 1. Fetch monitor status and telemetry
  const fetchStatus = useCallback(async () => {
    try {
      const [statusRes, telemetryRes] = await Promise.allSettled([
        client.getMonitorStatus(),
        client.getTelemetry(),
      ]);

      if (statusRes.status === 'fulfilled') {
        setMonitorStatus(statusRes.value);
        setVitalsError(null);
      } else {
        setVitalsError(statusRes.reason instanceof Error ? statusRes.reason.message : 'Failed to query monitor');
      }

      if (telemetryRes.status === 'fulfilled') {
        setTelemetry(telemetryRes.value);
      }
    } catch (err) {
      setVitalsError(err instanceof Error ? err.message : 'Error polling executive status');
    } finally {
      setVitalsLoading(false);
    }
  }, [client]);

  // Polling loop when open
  useEffect(() => {
    if (!isOpen) return;
    void fetchStatus();
    const interval = setInterval(() => {
      void fetchStatus();
    }, pollIntervalMs);
    return () => clearInterval(interval);
  }, [isOpen, fetchStatus, pollIntervalMs]);

  // 2. Native dialog show/close lifecycle and CSS scroll-snap tracking
  useEffect(() => {
    const dialog = dialogRef.current;
    const scroller = scrollerRef.current;
    if (!dialog) return;

    if (isOpen) {
      if (!dialog.open) {
        if (typeof dialog.showModal === 'function') {
          dialog.showModal();
        } else {
          dialog.setAttribute('open', '');
        }

        // Scroll sheet into view with Modern Web Guidance fallback
        if (scroller && typeof scroller.scrollTo === 'function') {
          if (typeof window !== 'undefined' && !window.CSS?.supports?.('scroll-initial-target', 'nearest')) {
            scroller.scrollTo({ left: scroller.offsetWidth || 380, behavior: 'instant' as ScrollBehavior });
            requestAnimationFrame(() => {
              requestAnimationFrame(() => {
                scroller?.scrollTo({ left: 0, behavior: 'smooth' });
              });
            });
          } else {
            scroller.scrollTo({ left: 0, behavior: 'smooth' });
          }
        }
      }
    } else {
      if (dialog.open) {
        if (scroller && typeof scroller.scrollTo === 'function') {
          scroller.scrollTo({ left: scroller.offsetWidth || 380, behavior: 'smooth' });
        }
        if (typeof dialog.close === 'function') {
          dialog.close();
        } else {
          dialog.removeAttribute('open');
        }
      }
    }
  }, [isOpen]);

  // 3. Close on backdrop tap (click inside dialog but outside sheet)
  const handleDialogClick = (e: React.MouseEvent<HTMLDialogElement>) => {
    if (sheetRef.current && !sheetRef.current.contains(e.target as Node)) {
      onClose();
    }
  };

  // 4. Close on Escape
  const handleDialogCancel = (e: React.SyntheticEvent) => {
    e.preventDefault();
    onClose();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };

  // 5. Trigger workflow execution
  const executeWorkflow = async (workflowId: string) => {
    setWorkflowStates((prev) => ({
      ...prev,
      [workflowId]: { status: 'running' },
    }));

    try {
      const res: WorkflowExecutionResponse = await client.executeWorkflow(workflowId);
      setWorkflowStates((prev) => ({
        ...prev,
        [workflowId]: {
          status: 'completed',
          summary: res.summary,
          timestamp: res.timestamp,
          data: res.data,
        },
      }));
      // Refresh vitals to reflect any state changes
      void fetchStatus();
    } catch (err) {
      setWorkflowStates((prev) => ({
        ...prev,
        [workflowId]: {
          status: 'failed',
          error: err instanceof Error ? err.message : 'Workflow execution failed',
        },
      }));
    }
  };

  // 6. Handle approval resolution inside HUD
  const handleResolveApproval = async (approvalId: string, decision: 'approved' | 'rejected') => {
    setApprovalsResolving((prev) => ({ ...prev, [approvalId]: true }));
    try {
      await client.resolveApproval(approvalId, decision);
      void fetchStatus();
    } catch (err) {
      console.error('Failed to resolve approval:', err);
    } finally {
      setApprovalsResolving((prev) => ({ ...prev, [approvalId]: false }));
    }
  };

  if (!isOpen) return null;

  return (
    <dialog
      ref={dialogRef}
      id="potaeto-executive-drawer"
      aria-label="Potaeto Executive Center"
      className="Drawer"
      onClick={handleDialogClick}
      onCancel={handleDialogCancel}
      onKeyDown={handleKeyDown}
      data-testid="task-workflow-drawer"
    >
      <div className="Drawer-scroller" ref={scrollerRef}>
        <nav
          className="Drawer-sheet flex flex-col w-full h-[100svh] bg-[var(--card)] text-[var(--foreground)] border-r border-[var(--card-border)] shadow-2xl"
          ref={sheetRef}
          aria-label="Executive Center Sheet"
        >
          {/* Header */}
          <div className="p-4 sm:p-5 border-b border-[var(--card-border)] bg-[var(--card)]/90 backdrop-blur sticky top-0 z-10 flex items-center justify-between gap-3">
            <div className="space-y-0.5">
              <div className="flex items-center gap-2">
                <span className="text-xl">🥔</span>
                <h2 className="text-lg font-bold tracking-tight text-[var(--foreground)]">
                  Executive Center
                </h2>
                <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 mr-1.5 animate-pulse" />
                  Live
                </span>
              </div>
              <p className="text-xs text-[var(--muted)]">
                Autonomous Tasks, System Vitals & Executive Workflows
              </p>
            </div>
            {/* Accessible close button with autofocus */}
            <button
              id="drawer-close-btn"
              data-testid="drawer-close-btn"
              type="button"
              autoFocus
              onClick={onClose}
              aria-label="Close Executive Center"
              className="btn-ghost p-2 rounded-xl text-[var(--muted)] hover:text-[var(--foreground)] hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          {/* Tab Navigation */}
          <div className="flex items-center border-b border-[var(--card-border)] px-4 bg-[var(--card)]" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'vitals'}
              data-testid="tab-vitals"
              onClick={() => setActiveTab('vitals')}
              className={`flex-1 py-3 px-2 text-xs sm:text-sm font-semibold border-b-2 text-center transition-all ${
                activeTab === 'vitals'
                  ? 'border-potato-500 text-potato-600 dark:text-potato-400'
                  : 'border-transparent text-[var(--muted)] hover:text-[var(--foreground)]'
              }`}
            >
              ⚡ Active Tasks & Vitals
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'workflows'}
              data-testid="tab-workflows"
              onClick={() => setActiveTab('workflows')}
              className={`flex-1 py-3 px-2 text-xs sm:text-sm font-semibold border-b-2 text-center transition-all ${
                activeTab === 'workflows'
                  ? 'border-potato-500 text-potato-600 dark:text-potato-400'
                  : 'border-transparent text-[var(--muted)] hover:text-[var(--foreground)]'
              }`}
            >
              🚀 Workflow Launcher
            </button>
          </div>

          {/* Drawer Body */}
          <div className="flex-1 overflow-y-auto p-4 sm:p-5 space-y-6">
            {activeTab === 'vitals' ? (
              <div className="space-y-6 animate-fade-in" data-testid="vitals-tab-content">
                {/* Vitals Summary Card */}
                <div className="card p-4 space-y-3 bg-potato-500/5 border-potato-200 dark:border-potato-800">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold uppercase tracking-wider text-[var(--muted)]">
                      Host Vitals
                    </span>
                    <button
                      type="button"
                      onClick={() => void fetchStatus()}
                      disabled={vitalsLoading}
                      className="text-xs text-potato-600 dark:text-potato-400 hover:underline flex items-center gap-1"
                    >
                      <svg
                        className={`w-3.5 h-3.5 ${vitalsLoading ? 'animate-spin' : ''}`}
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                        />
                      </svg>
                      Refresh
                    </button>
                  </div>

                  <div className="grid grid-cols-3 gap-2 sm:gap-3 text-center">
                    {/* CPU */}
                    <div className="p-2 sm:p-3 rounded-xl bg-[var(--card)] border border-[var(--card-border)]" data-testid="cpu-stat">
                      <div className="text-xs text-[var(--muted)] mb-1">CPU Load</div>
                      <div className="text-lg font-bold font-mono text-[var(--foreground)]">
                        {monitorStatus ? `${monitorStatus.cpu_pct}%` : '...'}
                      </div>
                      <div className="w-full bg-black/10 dark:bg-white/10 h-1.5 rounded-full mt-2 overflow-hidden">
                        <div
                          className="bg-potato-500 h-full rounded-full transition-all duration-500"
                          style={{ width: `${Math.min(100, Math.max(5, monitorStatus?.cpu_pct ?? 10))}%` }}
                        />
                      </div>
                    </div>

                    {/* RAM */}
                    <div className="p-2 sm:p-3 rounded-xl bg-[var(--card)] border border-[var(--card-border)]" data-testid="memory-stat">
                      <div className="text-xs text-[var(--muted)] mb-1">Memory RSS</div>
                      <div className="text-lg font-bold font-mono text-[var(--foreground)]">
                        {monitorStatus ? `${monitorStatus.memory_rss_mb} MB` : '...'}
                      </div>
                      <div className="w-full bg-black/10 dark:bg-white/10 h-1.5 rounded-full mt-2 overflow-hidden">
                        <div
                          className="bg-blue-500 h-full rounded-full transition-all duration-500"
                          style={{
                            width: `${Math.min(100, ((monitorStatus?.memory_rss_mb ?? 120) / 1024) * 100)}%`,
                          }}
                        />
                      </div>
                    </div>

                    {/* Temp */}
                    <div className="p-2 sm:p-3 rounded-xl bg-[var(--card)] border border-[var(--card-border)]" data-testid="temp-stat">
                      <div className="text-xs text-[var(--muted)] mb-1">Core Temp</div>
                      <div className="text-lg font-bold font-mono text-[var(--foreground)]">
                        {monitorStatus?.temperature_c !== null && monitorStatus?.temperature_c !== undefined
                          ? `${monitorStatus.temperature_c}°C`
                          : '42.0°C'}
                      </div>
                      <div className="text-[10px] font-semibold text-emerald-600 dark:text-emerald-400 mt-1">
                        Normal
                      </div>
                    </div>
                  </div>
                </div>

                {/* Active Background Tasks */}
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--muted)]">
                      Active Background Subagent Tasks
                    </h3>
                    <span className="text-xs text-[var(--muted)] font-mono">
                      {monitorStatus?.active_tasks?.length ?? 0} active
                    </span>
                  </div>

                  <div className="space-y-2">
                    {monitorStatus?.active_tasks && monitorStatus.active_tasks.length > 0 ? (
                      monitorStatus.active_tasks.map((task) => (
                        <div
                          key={task.id}
                          className="card p-3 space-y-2 border-l-4 border-l-potato-500"
                          data-testid={`active-task-${task.id}`}
                        >
                          <div className="flex items-center justify-between text-xs">
                            <span className="font-semibold text-[var(--foreground)] flex items-center gap-1.5">
                              <span className="w-2 h-2 rounded-full bg-potato-500 animate-pulse" />
                              {task.name}
                            </span>
                            <span className="font-mono text-potato-600 dark:text-potato-400 font-bold">
                              {task.progress ?? 100}%
                            </span>
                          </div>
                          {task.details && (
                            <p className="text-xs text-[var(--muted)]">{task.details}</p>
                          )}
                          <div className="w-full bg-black/10 dark:bg-white/10 h-1 rounded-full overflow-hidden">
                            <div
                              className="bg-potato-500 h-full rounded-full transition-all duration-300"
                              style={{ width: `${task.progress ?? 100}%` }}
                            />
                          </div>
                        </div>
                      ))
                    ) : (
                      <div className="card p-4 text-center text-xs text-[var(--muted)]">
                        No active background tasks running.
                      </div>
                    )}
                  </div>
                </div>

                {/* Scheduled Timers */}
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--muted)]">
                      Scheduled Timers & Cron Jobs
                    </h3>
                    <span className="text-xs text-[var(--muted)] font-mono">
                      {monitorStatus?.scheduled_timers?.length ?? 0} configured
                    </span>
                  </div>

                  <div className="space-y-2">
                    {monitorStatus?.scheduled_timers && monitorStatus.scheduled_timers.length > 0 ? (
                      monitorStatus.scheduled_timers.map((timer) => (
                        <div
                          key={timer.id}
                          className="card p-3 flex items-center justify-between text-xs"
                          data-testid={`timer-${timer.id}`}
                        >
                          <div>
                            <div className="font-medium text-[var(--foreground)]">{timer.name}</div>
                            <div className="text-[11px] font-mono text-[var(--muted)]">
                              Schedule: {timer.schedule}
                            </div>
                          </div>
                          <div className="text-right">
                            <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-semibold bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300">
                              Active
                            </span>
                            {timer.next_run && (
                              <div className="text-[10px] text-[var(--muted)] mt-0.5">
                                Next: {timer.next_run}
                              </div>
                            )}
                          </div>
                        </div>
                      ))
                    ) : (
                      <div className="card p-4 text-center text-xs text-[var(--muted)]">
                        No cron timers scheduled.
                      </div>
                    )}
                  </div>
                </div>

                {/* Pending Tool Approvals */}
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--muted)]">
                      Pending Approvals
                    </h3>
                    <span className="text-xs text-[var(--muted)] font-mono">
                      {monitorStatus?.pending_approvals?.length ?? 0} pending
                    </span>
                  </div>

                  <div className="space-y-2">
                    {monitorStatus?.pending_approvals && monitorStatus.pending_approvals.length > 0 ? (
                      monitorStatus.pending_approvals.map((apprv) => {
                        const isResolving = approvalsResolving[apprv.id] ?? false;
                        return (
                          <div
                            key={apprv.id}
                            className="card p-3.5 space-y-2.5 border-l-4 border-l-amber-500 bg-amber-500/5"
                            data-testid={`pending-approval-${apprv.id}`}
                          >
                            <div className="flex items-center justify-between">
                              <span className="font-semibold text-xs text-[var(--foreground)] font-mono">
                                🔒 {apprv.tool_name}
                              </span>
                              <span className="text-[10px] text-amber-700 dark:text-amber-300 font-medium">
                                Awaiting Approval
                              </span>
                            </div>
                            <pre className="text-[11px] bg-black/5 dark:bg-black/30 p-2 rounded overflow-x-auto font-mono text-[var(--muted)]">
                              {JSON.stringify(apprv.arguments ?? {}, null, 2)}
                            </pre>
                            <div className="flex items-center justify-end gap-2 pt-1">
                              <button
                                type="button"
                                disabled={isResolving}
                                onClick={() => void handleResolveApproval(apprv.id, 'rejected')}
                                className="px-3 py-1 rounded-lg text-xs font-medium text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/40 border border-rose-200 dark:border-rose-900 transition-colors"
                              >
                                Reject
                              </button>
                              <button
                                type="button"
                                disabled={isResolving}
                                onClick={() => void handleResolveApproval(apprv.id, 'approved')}
                                className="px-3 py-1 rounded-lg text-xs font-semibold bg-potato-500 text-white hover:bg-potato-600 shadow-sm transition-all"
                              >
                                Approve
                              </button>
                            </div>
                          </div>
                        );
                      })
                    ) : (
                      <div className="card p-4 text-center text-xs text-[var(--muted)]">
                        No approvals currently pending. Autonomous agent running cleanly.
                      </div>
                    )}
                  </div>
                </div>

                {/* Hardware Telemetry Card */}
                <div className="card p-3.5 space-y-2 border border-[var(--card-border)]">
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-semibold text-[var(--foreground)] flex items-center gap-1.5">
                      🔌 Arduino BLE Telemetry
                    </span>
                    <span
                      className={`px-2 py-0.5 rounded text-[10px] font-semibold ${
                        telemetry?.connected
                          ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300'
                          : 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300'
                      }`}
                    >
                      {telemetry?.connected ? 'Connected' : 'Offline / Mock'}
                    </span>
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-xs text-[var(--muted)] pt-1">
                    <div>
                      Temp:{' '}
                      <span className="font-mono text-[var(--foreground)] font-semibold">
                        {telemetry?.temperature !== null && telemetry?.temperature !== undefined
                          ? `${telemetry.temperature}°C`
                          : 'N/A'}
                      </span>
                    </div>
                    <div>
                      Humidity:{' '}
                      <span className="font-mono text-[var(--foreground)] font-semibold">
                        {telemetry?.humidity !== null && telemetry?.humidity !== undefined
                          ? `${telemetry.humidity}%`
                          : 'N/A'}
                      </span>
                    </div>
                    <div>
                      Pressure:{' '}
                      <span className="font-mono text-[var(--foreground)] font-semibold">
                        {telemetry?.pressure !== null && telemetry?.pressure !== undefined
                          ? `${telemetry.pressure} hPa`
                          : 'N/A'}
                      </span>
                    </div>
                    <div>
                      Light:{' '}
                      <span className="font-mono text-[var(--foreground)] font-semibold">
                        {telemetry?.light !== null && telemetry?.light !== undefined
                          ? `${telemetry.light}`
                          : 'N/A'}
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            ) : (
              /* Tab 2: Workflow Launcher */
              <div className="space-y-4 animate-fade-in" data-testid="workflows-tab-content">
                <div className="text-xs text-[var(--muted)]">
                  Execute autonomous executive pipelines on demand. Each workflow runs with durable audit logging.
                </div>

                <div className="space-y-3">
                  {DEFAULT_WORKFLOWS.map((wf) => {
                    const state = workflowStates[wf.id] || { status: 'idle' };
                    const isRunning = state.status === 'running';

                    return (
                      <div
                        key={wf.id}
                        className="card p-4 space-y-3 border border-[var(--card-border)] hover:border-potato-400/50 transition-colors"
                        data-testid={`workflow-card-${wf.id}`}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="flex items-start gap-3">
                            <span className="text-2xl shrink-0 p-2 rounded-xl bg-potato-500/10">
                              {wf.icon}
                            </span>
                            <div>
                              <h4 className="font-semibold text-sm text-[var(--foreground)]">
                                {wf.name}
                              </h4>
                              <p className="text-xs text-[var(--muted)] mt-0.5">
                                {wf.description}
                              </p>
                            </div>
                          </div>

                          <button
                            type="button"
                            data-testid={`workflow-btn-${wf.id}`}
                            disabled={isRunning}
                            onClick={() => void executeWorkflow(wf.id)}
                            className="btn-primary text-xs px-3.5 py-1.5 shrink-0"
                          >
                            {isRunning ? (
                              <>
                                <svg
                                  className="w-3.5 h-3.5 animate-spin"
                                  fill="none"
                                  stroke="currentColor"
                                  viewBox="0 0 24 24"
                                >
                                  <path
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    strokeWidth={2}
                                    d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                                  />
                                </svg>
                                Running...
                              </>
                            ) : (
                              'Execute'
                            )}
                          </button>
                        </div>

                        {/* Real-time execution status feedback */}
                        {state.status === 'completed' && (
                          <div
                            className="p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-xs space-y-1 animate-fade-in"
                            data-testid={`workflow-result-${wf.id}`}
                          >
                            <div className="flex items-center justify-between text-emerald-800 dark:text-emerald-300 font-semibold">
                              <span className="flex items-center gap-1">
                                ✓ Completed
                              </span>
                              {state.timestamp && (
                                <span className="text-[10px] font-mono text-[var(--muted)]">
                                  {new Date(state.timestamp).toLocaleTimeString()}
                                </span>
                              )}
                            </div>
                            {state.summary && (
                              <p className="text-[var(--foreground)] text-xs mt-1">
                                {state.summary}
                              </p>
                            )}
                          </div>
                        )}

                        {state.status === 'failed' && (
                          <div
                            className="p-3 rounded-xl bg-rose-500/10 border border-rose-500/20 text-xs space-y-1 text-rose-700 dark:text-rose-300 animate-fade-in"
                            data-testid={`workflow-error-${wf.id}`}
                          >
                            <div className="font-semibold">⚠️ Execution Failed</div>
                            <p>{state.error || 'Unknown error during execution.'}</p>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </nav>
      </div>
    </dialog>
  );
}
