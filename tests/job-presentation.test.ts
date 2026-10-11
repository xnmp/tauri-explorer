import { describe, expect, it } from "vitest";
import { formatJobCost, jobCost, jobReveal } from "$lib/domain/job-presentation";
const cost = { amount: "0.075", currency: "USD", estimated: false, source: "bfl.credits" };
describe("exact job cost display", () => {
  it.each([["0.075", "US$0.08"], ["0.005", "<US$0.01"], ["0.000001", "<US$0.01"], ["0", "US$0.00"], ["0.00", "US$0.00"], ["1.999999", "US$2.00"], ["12.345", "US$12.35"]])("formats %s", (amount, expected) => expect(formatJobCost({ ...cost, amount })).toBe(expected));
  it("marks estimates and other currencies", () => {
    expect(formatJobCost({ ...cost, estimated: true })).toBe("≈US$0.08");
    expect(formatJobCost({ ...cost, amount: "0.009", estimated: true })).toBe("≈<US$0.01");
    expect(formatJobCost({ ...cost, currency: "AUD" })).toBe("AUD 0.08");
    expect(formatJobCost({ ...cost, amount: "0.001", currency: "EUR" })).toBe("<EUR 0.01");
    expect(formatJobCost()).toBe("");
  });
  it("retains precision for extremely large decimals", () => expect(formatJobCost({ ...cost, amount: `${"9".repeat(200)}.995` })).toBe(`US$1${"0".repeat(200)}.00`));
  it("drops malformed metadata without a label", () => {
    for (const amount of [null, 0.08, "", "-1", "NaN", "1e3", "1.0000001", ".1", "1."]) expect(jobCost({ ...cost, amount })).toBeUndefined();
    for (const value of [null, {}, { ...cost, currency: "usd" }, { ...cost, estimated: 1 }, { ...cost, source: "x".repeat(65) }, { ...cost, extra: true }]) expect(jobCost(value)).toBeUndefined();
    expect(jobCost({ ...cost, source: "雪".repeat(64) })).toBeDefined();
  });
  it("validates both reveal targets", () => {
    expect(jobReveal({ kind: "file", path: "/images/output.png" })).toEqual({ kind: "file", path: "/images/output.png" });
    expect(jobReveal({ kind: "view", viewId: "trace.view", directory: "/images", targetId: "42" })).toBeDefined();
    for (const value of [null, {}, { kind: "file", path: "" }, { kind: "file", path: "x".repeat(4097) }, { kind: "file", path: "a\0b" }, { kind: "view", viewId: "bad id", directory: "/", targetId: "42" }, { kind: "view", viewId: "trace.view", directory: "/", targetId: "x".repeat(129) }]) expect(jobReveal(value)).toBeUndefined();
  });
});
