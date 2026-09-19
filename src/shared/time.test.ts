import { describe, expect, it } from "vitest";
import {
  DISPLAY_TIME_ZONE,
  formatDateOnly,
  formatInstantAsShanghaiIso,
  formatInstantDateTime,
  formatInstantTime,
} from "./time.js";

describe("Asia/Shanghai time display", () => {
  it("formats an absolute UTC instant across the local calendar boundary", () => {
    expect(formatInstantDateTime("2026-08-31T16:30:00.000Z")).toBe("2026-09-01 00:30");
    expect(formatInstantTime("2026-08-31T16:30:00.000Z")).toBe("00:30");
  });

  it("rejects missing, malformed, timezone-less, and impossible instants", () => {
    expect(formatInstantDateTime("")).toBe("—");
    expect(formatInstantDateTime("not-a-date")).toBe("—");
    expect(formatInstantDateTime("2026-09-01T00:30:00")).toBe("—");
    expect(formatInstantDateTime("2026-02-30T00:30:00Z")).toBe("—");
  });

  it("keeps date-only fields unchanged", () => {
    expect(formatDateOnly("2026-09-01")).toBe("2026-09-01");
    expect(formatDateOnly("")).toBe("—");
  });

  it("provides an equivalent ISO instant with the explicit +08:00 offset", () => {
    const utc = "2026-08-31T16:30:00.123Z";
    const local = formatInstantAsShanghaiIso(utc);
    expect(DISPLAY_TIME_ZONE).toBe("Asia/Shanghai");
    expect(local).toBe("2026-09-01T00:30:00.123+08:00");
    expect(Date.parse(local)).toBe(Date.parse(utc));
  });
});
