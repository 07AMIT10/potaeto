"""Read-only monitor tools: host health and outbound HTTP pings.

Both tools are best-effort observers. A missing sensor, an unreadable `/proc`
file, or an unreachable URL degrades to `None` / an error field instead of
raising into the agent loop.
"""

from __future__ import annotations

import httpx

from app.tools import monitor
from app.tools.monitor import MonitorTools


def test_system_health_returns_thresholds(db):
    h = MonitorTools(db).system_health()
    assert {"cpu_temp_c", "load_1m", "mem_available_mb", "disk_used_pct"} <= h.keys()


def test_system_health_reads_live_host_values(db):
    h = MonitorTools(db).system_health()
    assert h["load_1m"] is None or h["load_1m"] >= 0
    assert h["mem_available_mb"] is None or h["mem_available_mb"] > 0
    assert h["disk_used_pct"] is None or 0 <= h["disk_used_pct"] <= 100
    assert h["cpu_temp_c"] is None or h["cpu_temp_c"] > 0


def test_system_health_degrades_to_none(db, monkeypatch):
    monkeypatch.setattr(monitor, "_read_text", lambda _path: None)
    monkeypatch.setattr(monitor, "_cpu_temp_c", lambda: None)
    h = MonitorTools(db).system_health()
    assert h["cpu_temp_c"] is None
    assert h["load_1m"] is None
    assert h["mem_available_mb"] is None
    # Disk usage does not depend on the mocked readers.
    assert h["disk_used_pct"] is not None


def _monitor(db):
    """Monitor with the SSRF check stubbed out: these tests cover HTTP only."""
    return MonitorTools(db, ssrf_validator=lambda _url: None)


def test_http_ping_reports_status_and_latency(db, httpx_mock):
    httpx_mock.add_response(url="https://example.com/health", status_code=200)
    result = _monitor(db).http_ping("https://example.com/health")
    assert result["status"] == 200
    assert result["ok"] is True
    assert result["latency_ms"] >= 0
    assert result["error"] is None


def test_http_ping_does_not_follow_redirects(db, httpx_mock):
    httpx_mock.add_response(
        url="https://example.com/moved",
        status_code=302,
        headers={"Location": "http://169.254.169.254/latest/meta-data/"},  # pii-scan: allow-private-ip
    )
    result = _monitor(db).http_ping("https://example.com/moved")
    assert result["status"] == 302
    assert result["ok"] is False


def test_http_ping_reports_network_errors_without_raising(db, httpx_mock):
    httpx_mock.add_exception(
        httpx.ConnectTimeout("timed out"), url="https://down.example/"
    )
    result = _monitor(db).http_ping("https://down.example/")
    assert result["status"] is None
    assert result["ok"] is False
    assert "timed out" in (result["error"] or "").lower()


def test_http_ping_reports_invalid_url_without_raising(db):
    result = MonitorTools(db).http_ping("http://[::1")
    assert result["status"] is None
    assert result["ok"] is False
    assert result["error"]


def _zone(root, name: str, zone_type: str, millidegrees: int) -> None:
    zone = root / name
    zone.mkdir()
    (zone / "type").write_text(f"{zone_type}\n", encoding="ascii")
    (zone / "temp").write_text(f"{millidegrees}\n", encoding="ascii")


def test_cpu_temp_prefers_the_cpu_package_zone(tmp_path):
    # `acpitz` sorts first, but `x86_pkg_temp` is the real package sensor.
    _zone(tmp_path, "thermal_zone0", "acpitz", 45_000)
    _zone(tmp_path, "thermal_zone1", "x86_pkg_temp", 62_000)
    assert monitor._cpu_temp_c(str(tmp_path)) == 62.0


def test_cpu_temp_matches_tcpu_case_insensitively(tmp_path):
    _zone(tmp_path, "thermal_zone0", "acpitz", 45_000)
    _zone(tmp_path, "thermal_zone2", "TCPU", 71_000)
    assert monitor._cpu_temp_c(str(tmp_path)) == 71.0


def test_cpu_temp_falls_back_to_any_positive_zone(tmp_path):
    _zone(tmp_path, "thermal_zone0", "acpitz", 45_000)
    _zone(tmp_path, "thermal_zone1", "bogus", 0)
    assert monitor._cpu_temp_c(str(tmp_path)) == 45.0


def test_cpu_temp_returns_none_without_zones(tmp_path):
    assert monitor._cpu_temp_c(str(tmp_path)) is None
