
// Copied from https://github.com/glizzykingdreko/akamai-v3-sensor-data-helper/blob/main/src/extract_hash/index.js

import fs from "fs";
import * as parser from "@babel/parser";
import * as t from "@babel/types";
import generator from "@babel/generator";
import vm from "vm";

const generate = generator.default;

function createObfuscatedContext(filePath) {
  const fileContent = fs.readFileSync(filePath, "utf-8");

  const context = vm.createContext();

  const ast = parser.parse(fileContent);
  let expressionStatement = ast.program.body[1].expression.callee.body.body;

  const statementTypes = [
    { type: t.isVariableDeclaration },
    { type: t.isFunctionDeclaration },
    { type: t.isExpressionStatement },
    {
      type: (s) => t.isReturnStatement(s) && t.isCallExpression(s.argument),
      isReturn: true,
    },
  ];

  statementTypes.forEach(({ type, isReturn }) => {
    expressionStatement.forEach((statement) => {
      if (type(statement)) {
        try {
          const code = isReturn
            ? generate(statement.argument).code
            : generate(statement).code;
          vm.runInContext(code, context);
        } catch (error) { }
      }
    });
  });

  return context;
}
export default createObfuscatedContext;
