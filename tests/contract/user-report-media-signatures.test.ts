import { expect, it } from "vitest";
import contract from "./fixtures/report_relay.json";
import { validateUserReportAttachments, type UserReportMediaType } from "$lib/domain/user-report";
import { validateReport } from "../../website/api/_report-core.js";

it.each(contract.mediaCases)("frontend and relay agree on $name at attachment admission", (sample) => {
  const attachment = { name: sample.name, mediaType: sample.mediaType as UserReportMediaType, data: sample.data };
  expect(validateUserReportAttachments([attachment]) === null).toBe(sample.valid);
  const report = { title: "Signature contract", kind: "bug", body: "Steps", attachments: [attachment] };
  if (sample.valid) {
    expect(validateReport(report).attachments[0].mediaType).toBe(sample.mediaType);
  } else {
    expect(() => validateReport(report)).toThrow(expect.objectContaining({ code: "malformed_input" }));
  }
});
