import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import ts from "../packages/core/node_modules/typescript/lib/typescript.js";

const roots = ["packages/core/src", "apps/api/src", "apps/web/src"];
const violations = [];

for (const root of roots) {
    visitDirectory(root);
}

if (violations.length > 0) {
    console.error("项目生产 TypeScript 不允许声明 union type：");
    for (const violation of violations) {
        console.error(`${ violation.file }:${ violation.line }:${ violation.column } ${ violation.type }`);
    }
    process.exitCode = 1;
} else {
    console.log("Union type 检查通过。");
}

function visitDirectory(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) {
            visitDirectory(file);
        } else if (isProductionTypeScript(file)) {
            inspectFile(file);
        }
    }
}

function isProductionTypeScript(file) {
    return file.endsWith(".ts") && !file.endsWith(".d.ts") && !file.endsWith(".test.ts") && !file.endsWith(".spec.ts");
}

function inspectFile(file) {
    const source = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    visitNode(source, source, file);
}

function visitNode(node, source, file) {
    if (ts.isUnionTypeNode(node)) {
        const position = source.getLineAndCharacterOfPosition(node.getStart(source));
        violations.push({
            file,
            line: position.line + 1,
            column: position.character + 1,
            type: node.getText(source).replace(/\s+/g, " "),
        });
    }
    ts.forEachChild(node, (child) => visitNode(child, source, file));
}
