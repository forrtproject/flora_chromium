import {safeSendMessage, type SheetFetchResponse} from "@shared/messages";

export interface SheetTab { spreadsheetId: string; gid: string }

/** Sheets uses both query parameters and fragments; the active fragment wins. */
export function parseSheetsUrl(value: string): SheetTab | null {
    try {
        const url = new URL(value);
        const id = url.pathname.match(/^\/spreadsheets\/d\/([a-zA-Z0-9_-]+)(?:\/|$)/)?.[1];
        if (url.hostname !== "docs.google.com" || !id) return null;
        const gid = new URLSearchParams(url.hash.slice(1)).get("gid") ?? url.searchParams.get("gid") ?? "0";
        return /^\d+$/.test(gid) ? {spreadsheetId: id, gid} : null;
    } catch { return null; }
}

export function sheetTabKey(tab: SheetTab | null): string {
    return tab ? `${tab.spreadsheetId}:${tab.gid}` : "";
}

/** Empty CSV is a successful empty tab; absent/error responses are unavailable. */
export async function fetchSheetCsv(tab: SheetTab): Promise<string> {
    const response = await safeSendMessage<SheetFetchResponse>({type: "FLORA_SHEET_FETCH", ...tab});
    if (!response || response.error || typeof response.csv !== "string") {
        throw new Error(response?.error ?? "Sheet export unavailable");
    }
    // Google can redirect an inaccessible export to a sign-in page with HTTP 200.
    if (/^\s*(?:<!doctype\s+html|<html[\s>])/i.test(response.csv)) {
        throw new Error("Sheet export returned a sign-in or error page");
    }
    return response.csv;
}
