import * as path from 'path';
import * as ts from 'typescript';

const baseTsOptions: ts.CompilerOptions = {
  // We don't want symbols from external modules to be resolved, so we use the
  // classic algorithm.
  moduleResolution: ts.ModuleResolutionKind.Classic
};

export interface SerializationOptions {
  /**
   * Removes all exports matching the regular expression.
   */
  stripExportPattern?: RegExp;
  /**
   * Whitelists these identifiers as modules in the output. For example,
   * ```
   * import * as angular from './angularjs';
   *
   * export class Foo extends angular.Bar {}
   * ```
   * will produce `export class Foo extends angular.Bar {}` and requires
   * whitelisting angular.
   */
  allowModuleIdentifiers?: string[];
}

export function publicApi(fileName: string, options: SerializationOptions = {}): string {
  return publicApiInternal(ts.createCompilerHost(baseTsOptions), fileName, baseTsOptions, options);
}

export function publicApiInternal(
    host: ts.CompilerHost, fileName: string, tsOptions: ts.CompilerOptions,
    options: SerializationOptions = {}): string {
  const entrypoint = path.normalize(fileName);

  if (!entrypoint.match(/\.d\.ts$/)) {
    throw new Error(`Source file "${fileName}" is not a declaration file`);
  }

  const program = ts.createProgram([entrypoint], tsOptions, host);
  return emitResolvedDeclarations(program, entrypoint, options);
}

function emitResolvedDeclarations(
    program: ts.Program, fileName: string, options: SerializationOptions): string {
  const sourceFile = program.getSourceFiles().filter(sf => sf.fileName === fileName)[0];
  if (!sourceFile) {
    throw new Error(`Source file "${fileName}" not found`);
  }

  let output = '';

  const resolvedSymbols = getResolvedSymbols(program, sourceFile);
  // Sort all symbols so that the output is more deterministic
  resolvedSymbols.sort(symbolCompareFunction);
  for (const symbol of resolvedSymbols) {
    if (options.stripExportPattern && symbol.name.match(options.stripExportPattern)) {
      continue;
    }

    let decl: ts.Node = symbol.valueDeclaration || symbol.declarations && symbol.declarations[0];
    if (!decl) {
      console.warn(`No declaration found for symbol "${symbol.name}"`);
      continue;
    }

    // The declaration node may not be a complete statement, e.g. for var/const
    // symbols. We need to find the complete export statement by traversing
    // upwards.
    while (!(decl.flags & ts.NodeFlags.Export) && decl.parent) {
      decl = decl.parent;
    }
    if (decl.flags & ts.NodeFlags.Export) {
      // Make an empty line between two exports
      if (output) {
        output += '\n';
      }
      output += stripEmptyLines(getSanitizedText(decl, options)) + '\n';
    } else {
      // This may happen for symbols re-exported from external modules.
      console.warn(`Warning: No export declaration found for symbol "${symbol.name}"`);
    }
  }

  return output;
}

function getResolvedSymbols(program: ts.Program, sourceFile: ts.SourceFile): ts.Symbol[] {
  const typeChecker = program.getTypeChecker();

  const ms = (<any>sourceFile).symbol;
  const rawSymbols = ms ? (typeChecker.getExportsOfModule(ms) || []) : [];
  return rawSymbols.map(s => {
    if (s.flags & ts.SymbolFlags.Alias) {
      const resolvedSymbol = typeChecker.getAliasedSymbol(s);

      // This will happen, e.g. for symbols re-exported from external modules.
      if (!resolvedSymbol.valueDeclaration && !resolvedSymbol.declarations) {
        return s;
      }
      if (resolvedSymbol.name !== s.name) {
        throw new Error(
            `Symbol "${resolvedSymbol.name}" was aliased as "${s.name}". ` +
            `Aliases are not supported."`);
      }

      return resolvedSymbol;
    } else {
      return s;
    }
  });
}

function symbolCompareFunction(a: ts.Symbol, b: ts.Symbol) {
  return a.name.localeCompare(b.name);
}

function compareFunction<T>(a: T, b: T) {
  return a === b ? 0 : a > b ? 1 : -1;
}

/**
 * Traverses the node tree to construct the text without comments and privates.
 */
function getSanitizedText(node: ts.Node, options: SerializationOptions): string {
  if (node.flags & ts.NodeFlags.Private) {
    return '';
  }

  const firstQualifier: ts.Identifier = getFirstQualifier(node);

  if (firstQualifier) {
    if (!options.allowModuleIdentifiers ||
        options.allowModuleIdentifiers.indexOf(firstQualifier.text) < 0) {
      throw new Error(createErrorMessage(
          firstQualifier, `Module identifier "${firstQualifier.text}" is not allowed. Remove it ` +
              `from source or whitelist it via --allowModuleIdentifiers.`));
    }
  }

  let children = node.getChildren();
  if (children.length) {
    // Sort declarations under a class or an interface
    if (node.kind === ts.SyntaxKind.SyntaxList) {
      switch (node.parent && node.parent.kind) {
        case ts.SyntaxKind.ClassDeclaration:
        case ts.SyntaxKind.InterfaceDeclaration: {
          // There can be multiple SyntaxLists under a class or an interface,
          // since SyntaxList is just an arbitrary data structure generated
          // by Node#getChildren(). We need to check that we are sorting the
          // right list.
          if (children.every(node => node.kind in memberDeclarationOrder)) {
            children = children.slice();
            children.sort((a: ts.Declaration, b: ts.Declaration) => {
              // Static after normal
              return compareFunction(
                         a.flags & ts.NodeFlags.Static, b.flags & ts.NodeFlags.Static) ||
                  // Our predefined order
                  compareFunction(memberDeclarationOrder[a.kind], memberDeclarationOrder[b.kind]) ||
                  // Alphebetical order
                  // We need safe dereferencing due to edge cases, e.g. having two call signatures
                  compareFunction((a.name || a).getText(), (b.name || b).getText());
            });
          }
          break;
        }
      }
    }
    return children.map(n => getSanitizedText(n, options)).join('');
  } else {
    const sourceText = node.getSourceFile().text;
    const ranges = ts.getLeadingCommentRanges(sourceText, node.pos);
    let tail = node.pos;
    for (const range of ranges || []) {
      if (range.end > tail) {
        tail = range.end;
      }
    }
    return sourceText.substring(tail, node.end);
  }
}

const memberDeclarationOrder = {
  [ts.SyntaxKind.PropertySignature]: 0,
  [ts.SyntaxKind.PropertyDeclaration]: 0,
  [ts.SyntaxKind.GetAccessor]: 0,
  [ts.SyntaxKind.SetAccessor]: 0,
  [ts.SyntaxKind.CallSignature]: 1,
  [ts.SyntaxKind.Constructor]: 2,
  [ts.SyntaxKind.ConstructSignature]: 2,
  [ts.SyntaxKind.IndexSignature]: 3,
  [ts.SyntaxKind.MethodSignature]: 4,
  [ts.SyntaxKind.MethodDeclaration]: 4
};

function stripEmptyLines(text: string): string {
  return text.split('\n').filter(x => !!x.length).join('\n');
}

/**
 * Returns the first qualifier if the input node is a dotted expression.
 */
function getFirstQualifier(node: ts.Node): ts.Identifier {
  if (node.kind === ts.SyntaxKind.PropertyAccessExpression) {
    // For expression position
    let lhs: ts.Node = node;
    do {
      lhs = (<ts.PropertyAccessExpression>lhs).expression;
    } while (lhs && lhs.kind !== ts.SyntaxKind.Identifier);

    return <ts.Identifier>lhs;

  } else if (node.kind === ts.SyntaxKind.TypeReference) {
    // For type position
    let lhs: ts.Node = (<ts.TypeReferenceNode>node).typeName;
    do {
      lhs = (<ts.QualifiedName>lhs).left;
    } while (lhs && lhs.kind !== ts.SyntaxKind.Identifier);

    return <ts.Identifier>lhs;

  } else {
    return null;
  }
}

function createErrorMessage(node: ts.Node, message): string {
  const sourceFile = node.getSourceFile();
  let position;
  if (sourceFile) {
    const {line, character} = sourceFile.getLineAndCharacterOfPosition(node.getStart());
    position = `${sourceFile.fileName}(${line + 1},${character + 1})`;
  } else {
    position = '<unknown>';
  }

  return `${position}: error: ${message}`;
}
