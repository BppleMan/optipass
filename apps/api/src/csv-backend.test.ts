import { describe, expect, it } from "vitest";
import { ItemFieldKind, ItemProvider } from "@optimize-password/core";
import { CsvItemBackend, parseCsv } from "./csv-backend.js";

describe("CsvItemBackend", () => {
    it("解析引号、逗号和字段内换行", () => {
        expect(parseCsv('A,B\r\n"a,b","line 1\nline 2"')).toEqual([
            ["A", "B"],
            ["a,b", "line 1\nline 2"],
        ]);
    });

    it("把 1Password CSV 映射为规范 Item", async () => {
        const backend = new CsvItemBackend();
        const result = await backend.readAll({
            accountId: "export.csv",
            sourceName: "export.csv",
            sourceContent: 'Title,Url,Username,Password,OTPAuth,Favorite,Archived,Tags,Notes\n"Example","https://example.com","user@example.com","***","","false","false","work,important","memo"',
        });
        expect(result.provider).toBe(ItemProvider.Csv);
        expect(result.items).toHaveLength(1);
        expect(result.items[0].fields.map((field) => field.kind)).toEqual([ItemFieldKind.Email, ItemFieldKind.Password]);
        expect(result.items[0].tags).toEqual(["work", "important"]);
    });
});
