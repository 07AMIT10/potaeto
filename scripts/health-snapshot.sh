#!/usr/bin/env bash
# Record one resource snapshot for the Release 1 acceptance evidence:
# core RSS (<= 250 MB), idle CPU (<= 5 %), CPU temperature, free RAM, and load.
#
# Usage:
#   scripts/health-snapshot.sh                    # potaeto-core via systemd
#   scripts/health-snapshot.sh potaeto-core 1234  # explicit unit and PID
#   POTAETO_HEALTH_LOG=/opt/potaeto/health.log \
#     scripts/health-snapshot.sh                  # append one line per run
#
# Run it every few minutes for 24 h (cron/systemd timer) and keep the output as
# the acceptance record. The CPU figure is a 1-second sample of the process's
# utime+stime, not the host-wide load.
set -euo pipefail

UNIT="${1:-potaeto-core}"
PID="${2:-}"

if [[ -z "$PID" ]]; then
	if command -v systemctl >/dev/null 2>&1; then
		PID="$(systemctl show -p MainPID --value "$UNIT" 2>/dev/null || true)"
	fi
fi
if [[ -z "$PID" || "$PID" == "0" || ! -d "/proc/$PID" ]]; then
	echo "health-snapshot: no running process for ${UNIT} (pass a unit and PID)" >&2
	exit 1
fi

read -r _ _ _ _ _ _ _ _ _ _ _ _ _ utime stime _ <"/proc/$PID/stat"
TICKS_PER_SEC="$(getconf CLK_TCK 2>/dev/null || echo 100)"
TOTAL1=$((utime + stime))
sleep 1
read -r _ _ _ _ _ _ _ _ _ _ _ _ _ utime stime _ <"/proc/$PID/stat"
TOTAL2=$((utime + stime))
CPU_PCT="$(awk -v a="$TOTAL1" -v b="$TOTAL2" -v hz="$TICKS_PER_SEC" \
	'BEGIN { printf "%.2f", (b - a) / hz * 100 }')"

RSS_KB="$(awk '/^VmRSS:/ { print $2 }' "/proc/$PID/status" 2>/dev/null || true)"
RSS_MB="$(awk -v kb="${RSS_KB:-0}" 'BEGIN { printf "%.1f", kb / 1024 }')"

# cgroup v2 path from the process itself; memory.current is the whole unit when
# the service is the only member of its cgroup.
CGROUP_PATH="$(awk -F: '$1 == "0" { print $3 }' "/proc/$PID/cgroup" 2>/dev/null || true)"
CGROUP_MB=""
if [[ -n "$CGROUP_PATH" && -r "/sys/fs/cgroup${CGROUP_PATH}/memory.current" ]]; then
	CGROUP_MB="$(awk '{ printf "%.1f", $1 / 1048576 }' "/sys/fs/cgroup${CGROUP_PATH}/memory.current")"
fi

TEMP_C=""
for zone in /sys/class/thermal/thermal_zone*; do
	[[ -r "$zone/type" && -r "$zone/temp" ]] || continue
	[[ "$(cat "$zone/type" 2>/dev/null)" == "x86_pkg_temp" ]] || continue
	TEMP_C="$(awk '{ printf "%.1f", $1 / 1000 }' "$zone/temp")"
	break
done
if [[ -z "$TEMP_C" ]]; then
	for zone in /sys/class/thermal/thermal_zone*; do
		[[ -r "$zone/temp" ]] || continue
		value="$(cat "$zone/temp" 2>/dev/null || true)"
		[[ -n "$value" && "$value" -gt 0 ]] 2>/dev/null || continue
		TEMP_C="$(awk -v v="$value" 'BEGIN { printf "%.1f", v / 1000 }')"
		break
	done
fi

MEM_AVAILABLE_MB="$(awk '/^MemAvailable:/ { printf "%.1f", $2 / 1024 }' /proc/meminfo)"
LOAD_1M="$(awk '{ print $1 }' /proc/loadavg)"
STAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

LINE="ts=${STAMP} unit=${UNIT} pid=${PID} rss_mb=${RSS_MB} cgroup_memory_mb=${CGROUP_MB:-n/a} cpu_pct=${CPU_PCT} cpu_temp_c=${TEMP_C:-n/a} mem_available_mb=${MEM_AVAILABLE_MB} load_1m=${LOAD_1M}"

if [[ -n "${POTAETO_HEALTH_LOG:-}" ]]; then
	printf '%s\n' "$LINE" >>"$POTAETO_HEALTH_LOG"
fi
printf '%s\n' "$LINE"
