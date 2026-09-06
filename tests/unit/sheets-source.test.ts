import {describe, expect, it, vi} from "vitest";
import {fetchSheetCsv, parseSheetsUrl, sheetTabKey} from "../../src/content-general/sheets";
import {safeSendMessage} from "../../src/shared/messages";

vi.mock("../../src/shared/messages", () => ({safeSendMessage: vi.fn()}));

describe("active Sheets source", () => {
    it("exports the linked query tab and follows a newer fragment selection", () => {
        expect(parseSheetsUrl("https://docs.google.com/spreadsheets/d/book/edit?gid=42"))
            .toEqual({spreadsheetId: "book", gid: "42"});
        expect(parseSheetsUrl("https://docs.google.com/spreadsheets/d/book/edit?gid=42#gid=99"))
            .toEqual({spreadsheetId: "book", gid: "99"});
        expect(sheetTabKey(parseSheetsUrl("https://docs.google.com/spreadsheets/d/other/edit#gid=99")))
            .not.toBe(sheetTabKey(parseSheetsUrl("https://docs.google.com/spreadsheets/d/book/edit#gid=99")));
    });

    it("distinguishes an empty tab from an unavailable export, allowing retry", async () => {
        const tab = {spreadsheetId: "book", gid: "42"};
        vi.mocked(safeSendMessage).mockResolvedValueOnce({error: "HTTP 403"});
        await expect(fetchSheetCsv(tab)).rejects.toThrow("HTTP 403");
        vi.mocked(safeSendMessage).mockResolvedValueOnce({csv: ""});
        await expect(fetchSheetCsv(tab)).resolves.toBe("");
        expect(safeSendMessage).toHaveBeenLastCalledWith({type: "FLORA_SHEET_FETCH", ...tab});
    });
});
