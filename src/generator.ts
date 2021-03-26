import path from "path";
import camelCase from "camelcase";
import {
    CodeBlockWriter,
    ImportDeclarationStructure,
    MethodSignatureStructure,
    OptionalKind,
    Project,
    PropertySignatureStructure,
    Structure,
    StructureKind,
} from "ts-morph";
import { Definition, Method, ParsedWsdl, XmlType } from "./models/parsed-wsdl";
import { Logger } from "./utils/logger";

export interface Options {
    emitDefinitionsOnly: boolean;
}

function createProperty(
    name: string,
    type: string,
    doc: string,
    isArray: boolean,
    optional = true
): PropertySignatureStructure {
    return {
        kind: StructureKind.PropertySignature,
        name: camelCase(name),
        docs: [doc],
        hasQuestionToken: true,
        type: isArray ? `Array<${type}>` : type,
    };
}

function allCasesHandled(p: never): any {}
function writeType(imports: string[], t: XmlType): { code: string; imports: string[] } {
    if (t.kind === "PRIMITIVE") {
        const typstr =
            t.type.toLowerCase() === "string"
                ? "string"
                : t.type.toLowerCase() === "int"
                ? "number"
                : t.type.toLowerCase() === "decimal"
                ? "number"
                : t.type.toLowerCase() === "boolean"
                ? "boolean"
                : t.type.toLowerCase() === "datetime"
                ? "Date"
                : t.type.toLowerCase() === "date"
                ? "Date"
                : "unknown";

        return { code: typstr + " | null", imports };
    } else if (t.kind === "ARRAY") {
        const inner = writeType(imports, t.type);
        return { code: `(${inner.code})[]`, imports: imports.concat(inner.imports) };
    } else if (t.kind === "REFERENCE") {
        return { code: t.ref, imports: imports.concat([t.kind]) };
    } else if (t.kind === "MAP") {
        const acc = t.properties.reduce(
            (acc, p) => {
                const inner = writeType(acc.imports, p.type);
                return {
                    imports: inner.imports,
                    code:
                        acc.code + (acc.code === "" ? "" : ",\n") + p.propName + ": " + inner.code,
                };
            },
            { imports: imports, code: "" }
        );
        return {
            imports: acc.imports,
            code: "{\n " + acc.code + "}",
        };
    } else {
        return allCasesHandled(t);
    }
}

function pushDefinitions(
    project: Project,
    definition: null | Definition,
    defDir: string,
    stack: string[],
    generated: Definition[]
): void {
    // const defFilePath = path.join(defDir, `${defName}.ts`);
    // const defFile = project.createSourceFile(defFilePath, "", {
    //     overwrite: true,
    // });

    generated.push(definition);

    // const definitionImports: OptionalKind<ImportDeclarationStructure>[] = [];
    // const definitionProperties: PropertySignatureStructure[] = [];
    // for (const prop of definition.properties) {
    //     if (prop.kind === "PRIMITIVE") {
    //         // e.g. string
    //         definitionProperties.push(
    //             createProperty(prop.name, prop.type, prop.description, prop.isArray)
    //         );
    //     } else if (prop.kind === "REFERENCE") {
    //         // e.g. Items
    //         if (!generated.includes(prop.ref)) {
    //             // Wasn't generated yet
    //             generateDefinitionFile(
    //                 project,
    //                 prop.ref,
    //                 defDir,
    //                 [...stack, prop.ref.name],
    //                 generated
    //             );
    //         }
    //         definitionImports.push({
    //             moduleSpecifier: `./${prop.ref.name}`,
    //             namedImports: [{ name: prop.ref.name }],
    //         });
    //         definitionProperties.push(
    //             createProperty(prop.name, prop.ref.name, prop.sourceName, prop.isArray)
    //         );
    //     }
    // }

    // defFile.addImportDeclarations(
    //     imports.map((i) => ({
    //         moduleSpecifier: i,
    //         namedImports: [{ name: i }],
    //     }))
    // );
    // Logger.log(`Writing Definition file: ${path.resolve(path.join(defDir, defName))}.ts`);
    // defFile.saveSync();
}

export async function generate(
    parsedWsdl: ParsedWsdl,
    outDir: string,
    options: Options
): Promise<void> {
    const project = new Project();

    const portsDir = path.join(outDir, "ports");
    const servicesDir = path.join(outDir, "services");
    const defDir = path.join(outDir, "definitions");

    const allMethods: Method[] = [];
    const allDefintions: Definition[] = [];

    const clientDefImports: string[] = [];
    const clientImports: Array<OptionalKind<ImportDeclarationStructure>> = [];
    const clientServices: Array<OptionalKind<PropertySignatureStructure>> = [];

    for (const service of parsedWsdl.services) {
        const serviceFilePath = path.join(servicesDir, `${service.name}.ts`);
        const serviceFile = project.createSourceFile(serviceFilePath, "", {
            overwrite: true,
        });

        const serviceImports: Array<OptionalKind<ImportDeclarationStructure>> = [];
        const servicePorts: Array<OptionalKind<PropertySignatureStructure>> = [];
        for (const port of parsedWsdl.ports) {
            const portFilePath = path.join(portsDir, `${port.name}.ts`);
            const portFile = project.createSourceFile(portFilePath, "", {
                overwrite: true,
            });

            const portImports: string[] = [];
            const portFileMethods: Array<OptionalKind<MethodSignatureStructure>> = [];
            for (const method of port.methods) {
                // TODO: Deduplicate PortImports
                if (
                    method.paramDefinition !== null &&
                    !allDefintions.includes(method.paramDefinition)
                ) {
                    pushDefinitions(
                        project,
                        method.paramDefinition,
                        defDir,
                        [method.paramDefinition.name],
                        allDefintions
                    );
                    clientDefImports.push(method.paramDefinition.name);
                    portImports.push(method.paramDefinition.name);
                }
                if (
                    method.returnDefinition !== null &&
                    !allDefintions.includes(method.returnDefinition)
                ) {
                    pushDefinitions(
                        project,
                        method.returnDefinition,
                        defDir,
                        [method.returnDefinition.name],
                        allDefintions
                    );
                    clientDefImports.push(method.returnDefinition.name);
                    portImports.push(method.returnDefinition.name);
                }
                // TODO: Deduplicate PortMethods
                allMethods.push(method);
                portFileMethods.push({
                    name: method.paramName,
                    parameters: [
                        {
                            name: method.paramName,
                            type: method.paramDefinition ? method.paramDefinition.name : "{}",
                        },
                        {
                            name: "callback",
                            type: `(err: any, result: ${
                                method.paramDefinition ? method.paramDefinition.name : "unknown"
                            }, rawResponse: any, soapHeader: any, rawRequest: any) => void`,
                        },
                    ],
                    returnType: method.returnDefinition ? method.returnDefinition.name : "void",
                });
            } // End of PortMethod
            if (!options.emitDefinitionsOnly) {
                serviceImports.push({
                    moduleSpecifier: path.join("..", "ports", port.name),
                    namedImports: [{ name: port.name }],
                });
                servicePorts.push({
                    name: port.name,
                    isReadonly: true,
                    type: port.name,
                });
                portFile.addImportDeclarations([
                    {
                        moduleSpecifier: path.join("..", "definitions", "definitions"),
                        namedImports: portImports,
                    },
                ]);
                portFile.addStatements([
                    {
                        leadingTrivia: (writer) => writer.newLine(),
                        isExported: true,
                        kind: StructureKind.Interface,
                        name: port.name,
                        methods: portFileMethods,
                    },
                ]);
                Logger.log(`Writing Port file: ${path.resolve(path.join(portsDir, port.name))}.ts`);
                portFile.saveSync();
            }
        } // End of Port

        if (!options.emitDefinitionsOnly) {
            clientImports.push({
                moduleSpecifier: `./services/${service.name}`,
                namedImports: [{ name: service.name }],
            });
            clientServices.push({ name: service.name, type: service.name });

            serviceFile.addImportDeclarations(serviceImports);
            serviceFile.addStatements([
                {
                    leadingTrivia: (writer) => writer.newLine(),
                    isExported: true,
                    kind: StructureKind.Interface,
                    name: service.name,
                    properties: servicePorts,
                },
            ]);
            Logger.log(
                `Writing Service file: ${path.resolve(path.join(servicesDir, service.name))}.ts`
            );
            serviceFile.saveSync();
        }
    } // End of Service

    const defFilePath = path.join(defDir, `definitions.ts`);
    const defFile = project.createSourceFile(defFilePath, "", {
        overwrite: true,
    });
    allDefintions.forEach(function (definition) {
        const { code } = writeType([], definition.type);
        const defName = camelCase(definition.name, { pascalCase: true });

        defFile.addStatements([
            {
                leadingTrivia: (writer) => writer.newLine(),
                isExported: true,
                name: defName,
                docs: [definition.docs.join("\n")],
                kind: StructureKind.TypeAlias,
                type: code,
            },
        ]);
        defFile.saveSync();
    });

    if (!options.emitDefinitionsOnly) {
        const clientFilePath = path.join(outDir, "client.ts");
        const clientFile = project.createSourceFile(clientFilePath, "", {
            overwrite: true,
        });
        clientFile.addImportDeclaration({
            moduleSpecifier: "soap",
            namedImports: [
                { name: "Client", alias: "SoapClient" },
                { name: "createClientAsync", alias: "soapCreateClientAsync" },
            ],
        });
        clientImports.push({
            moduleSpecifier: `./definitions/definitions`,
            namedImports: clientDefImports,
        });
        clientFile.addImportDeclarations(clientImports);
        clientFile.addStatements([
            {
                leadingTrivia: (writer) => writer.newLine(),
                isExported: true,
                kind: StructureKind.Interface,
                // docs: [`${parsedWsdl.name}Client`],
                name: `${parsedWsdl.name}Client`,
                properties: clientServices,
                extends: ["SoapClient"],
                methods: allMethods.map<OptionalKind<MethodSignatureStructure>>((method) => ({
                    name: `${method.name}Async`,
                    parameters: [
                        {
                            name: method.paramName,
                            type: method.paramDefinition ? method.paramDefinition.name : "{}",
                        },
                    ],
                    returnType: `Promise<${
                        method.returnDefinition ? method.returnDefinition.name : "unknown"
                    }>`,
                })),
            },
        ]);
        const createClientDeclaration = clientFile.addFunction({
            name: "createClientAsync",
            docs: [`Create ${parsedWsdl.name}Client`],
            isExported: true,
            parameters: [
                {
                    isRestParameter: true,
                    name: "args",
                    type: "Parameters<typeof soapCreateClientAsync>",
                },
            ],
            returnType: `Promise<${parsedWsdl.name}Client>`, // TODO: `any` keyword is very dangerous
        });
        createClientDeclaration.setBodyText(
            "return soapCreateClientAsync(args[0], args[1], args[2]) as any;"
        );
        Logger.log(`Writing Client file: ${path.resolve(path.join(outDir, "client"))}.ts`);
        clientFile.saveSync();
    }

    const indexFilePath = path.join(outDir, "index.ts");
    const indexFile = project.createSourceFile(indexFilePath, "", {
        overwrite: true,
    });

    indexFile.addExportDeclarations([
        {
            namedExports: allDefintions.map((def) => def.name),
            moduleSpecifier: `./definitions/definitions`,
        },
    ]);
    if (!options.emitDefinitionsOnly) {
        // TODO: Aggregate all exports during decleartions generation
        // https://ts-morph.com/details/exports
        indexFile.addExportDeclarations([
            {
                namedExports: ["createClientAsync", `${parsedWsdl.name}Client`],
                moduleSpecifier: "./client",
            },
        ]);
        indexFile.addExportDeclarations(
            parsedWsdl.services.map((service) => ({
                namedExports: [service.name],
                moduleSpecifier: `./services/${service.name}`,
            }))
        );
        indexFile.addExportDeclarations(
            parsedWsdl.ports.map((port) => ({
                namedExports: [port.name],
                moduleSpecifier: `./ports/${port.name}`,
            }))
        );
    }

    Logger.log(`Writing Index file: ${path.resolve(path.join(outDir, "index"))}.ts`);

    indexFile.saveSync();
}
