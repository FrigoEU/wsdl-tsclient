import camelCase from "camelcase";
import * as path from "path";
import {
    ComplexTypeElement,
    SequenceElement,
    ElementElement,
    Element,
    ComplexContentElement,
} from "soap/lib/wsdl/elements";
import { open_wsdl, WSDL } from "soap/lib/wsdl/index";
import { Definition, XmlType, Method, ParsedWsdl, Port, Service } from "./models/parsed-wsdl";
import { stripExtension } from "./utils/file";
import { reservedKeywords } from "./utils/javascript";
import { Logger } from "./utils/logger";

interface Options {
    modelNamePreffix: string;
    modelNameSuffix: string;
}

type VisitedDefinition = {
    name: string;
    parts: object;
    definition: Definition;
};

function findReferenceDefiniton(visited: Array<VisitedDefinition>, name: string) {
    return visited.find((def) => def.name === name);
}

function findTypeByName(
    parsedWsdl: ParsedWsdl,
    wsdl: WSDL,
    options: Options,
    stack: string[],
    visitedDefs: Array<VisitedDefinition>,
    name: string,
    namespace: string
): XmlType {
    if (!name) {
        return null;
    }
    const split = !namespace && name.includes(":") ? name.split(":") : null;
    const ns = split
        ? wsdl.definitions.xmlns[split[0]] || split[0]
        : wsdl.definitions.xmlns[namespace] || namespace;
    if (!ns) {
        throw new Error(`parseComplexType: No namespace provided, name: ${name}`);
    }
    const defName = split ? split[1] : name;
    const type = wsdl.definitions.schemas[ns]?.complexTypes[defName];

    const visited = findReferenceDefiniton(visitedDefs, defName);
    if (visited) {
        // By referencing already declared definition, we will avoid circular references
        return {
            kind: "REFERENCE",
            ref: visited.name,
        };
    }

    if (!type) {
        // throw new Error(`parseComplexType: Complex type not found, name: ${name}, ns: ${ns}`);
        return { kind: "PRIMITIVE", type: defName };
    }

    const t = handleProp(parsedWsdl, wsdl, options, stack, visitedDefs, [
        type.children[0].$name,
        type.children[0],
    ]);

    const def: Definition = {
        name: `${options.modelNamePreffix}${parsedWsdl.findNonCollisionDefinitionName(defName)}${
            options.modelNameSuffix
        }`,
        sourceName: defName,
        docs: [name],
        type: t,
        description: "",
    };

    parsedWsdl.definitions.push(def);

    return t;
}

function handleProp(
    parsedWsdl: ParsedWsdl,
    wsdl: WSDL,
    options: Options,
    stack: string[],
    visitedDefs: Array<VisitedDefinition>,
    [propName, type]: [string, Element]
): XmlType | null {
    if (propName === "targetNSAlias") {
        return null; // [`targetNSAlias \`${type}\``];
    } else if (propName === "targetNamespace") {
        return null; // [`targetNamespace \`${type}\``];
    } else if (type instanceof Element && (type as any).$base === "soapenc:Array") {
        const typeC = type.children.find((c) => (c as any).$ref === "soapenc:arrayType");
        if (typeC) {
            const arrayType = (typeC as any)["$n1:arrayType"]; // eg: ns1:TEmployee[] . TODO: Can this namespace be dynamic?
            const subDefinition = findTypeByName(
                parsedWsdl,
                wsdl,
                options,
                stack,
                visitedDefs,
                arrayType.substring(0, arrayType.length - 2),
                ""
                // propName,
                // type,
                // [...stack, propName],
                // visitedDefs
            );
            return { kind: "ARRAY", type: subDefinition };
        } else {
            throw new Error("soapenc:Array with soapenc:arrayType");
        }
    } else if (type instanceof ComplexContentElement) {
        return {
            kind: "MAP",
            properties: [
                {
                    propName: "item",
                    type: handleProp(parsedWsdl, wsdl, options, stack, visitedDefs, [
                        type.children[0].$name,
                        type.children[0],
                    ]),
                },
            ],
        };
    } else if (type instanceof SequenceElement) {
        return {
            kind: "MAP",
            properties: type.children.map((e) => ({
                propName: e.$name,
                type: handleProp(parsedWsdl, wsdl, options, stack, visitedDefs, [e.$name, e]),
            })),
        };
    } else if (type instanceof ComplexTypeElement) {
        // todo find existing
        const subDefinition = findTypeByName(
            parsedWsdl,
            wsdl,
            options,
            stack,
            visitedDefs,
            type.$name,
            typeof type.xmlns === "string" ? type.xmlns : null
            // propName,
            // type,
            // [...stack, propName],
            // visitedDefs
        );
        return subDefinition;
    } else if (type instanceof ElementElement && type.$type) {
        // todo find existing
        const subDefinition = findTypeByName(
            parsedWsdl,
            wsdl,
            options,
            stack,
            visitedDefs,
            type.$type,
            typeof type.xmlns === "string" ? type.xmlns : null
            // propName,
            // type,
            // [...stack, propName],
            // visitedDefs
        );
        return subDefinition;
    } else {
        const subDefinition = findTypeByName(
            parsedWsdl,
            wsdl,
            options,
            stack,
            visitedDefs,
            type.$name,
            typeof type.xmlns === "string" ? type.xmlns : null
        );
        return subDefinition;
    }
}

/**
 * parse definition
 * @param parsedWsdl context of parsed wsdl
 * @param name name of definition
 * @param defParts definition's parts (its properties from wsdl)
 * @param stack definition stack (for deep objects) (immutable)
 * @param visitedDefs set of visited definition (mutable)
 */
function parseDefinition(
    parsedWsdl: ParsedWsdl,
    wsdl: WSDL,
    options: Options,
    name: string,
    defParts: { [propNameType: string]: any },
    stack: string[],
    visitedDefs: Array<VisitedDefinition>
): Definition {
    const defName = camelCase(name, { pascalCase: true });

    if (defParts) {
        // NOTE: `node-soap` has sometimes problem with parsing wsdl files, it includes `defParts.undefined = undefined`
        if ("undefined" in defParts && defParts.undefined === undefined) {
            // TODO: problem while parsing WSDL, maybe report to node-soap
            // TODO: add flag --FailOnWsdlError
            Logger.error({
                message: "Problem while generating a definition file",
                path: stack.join("."),
                parts: defParts,
            });
        } else {
            const t: XmlType = {
                kind: "MAP",
                properties: Object.entries(defParts).map(([k, p]) => ({
                    propName: k,
                    type: handleProp(parsedWsdl, wsdl, options, stack, visitedDefs, [k, p]),
                })),
            };

            const definition: Definition = {
                name: `${options.modelNamePreffix}${parsedWsdl.findNonCollisionDefinitionName(
                    defName
                )}${options.modelNameSuffix}`,
                sourceName: defName,
                docs: [name],
                type: t,
                description: "",
            };

            parsedWsdl.definitions.push(definition);

            visitedDefs.push({ name: definition.name, parts: defParts, definition }); // NOTE: cache reference to this defintion globally (for avoiding circular references)

            return definition;
        }
    }
    // TODO: Doesn't have parts :(
    throw new Error("Definition without parts");
}

// TODO: Add logs
// TODO: Add comments for services, ports, methods and client
export async function parseWsdl(wsdlPath: string, options: Options): Promise<ParsedWsdl> {
    return new Promise((resolve, reject) => {
        open_wsdl(wsdlPath, function (err, wsdl) {
            if (err) {
                return reject(err);
            }
            if (wsdl === undefined) {
                return reject(new Error("WSDL is undefined"));
            }

            wsdl.describeServices();

            const parsedWsdl = new ParsedWsdl();
            const filename = path.basename(wsdlPath);
            parsedWsdl.name = camelCase(stripExtension(filename), {
                pascalCase: true,
            });
            parsedWsdl.wsdlFilename = path.basename(filename);
            parsedWsdl.wsdlPath = path.resolve(wsdlPath);

            const visitedDefinitions: Array<VisitedDefinition> = [];

            const allMethods: Method[] = [];
            const allPorts: Port[] = [];
            const services: Service[] = [];
            for (const [serviceName, service] of Object.entries(wsdl.definitions.services)) {
                const servicePorts: Port[] = []; // TODO: Convert to Array

                for (const [portName, port] of Object.entries(service.ports)) {
                    // [SI_ManageOrder_O]
                    const portMethods: Method[] = [];

                    for (const [methodName, method] of Object.entries(port.binding.methods)) {
                        // [O_CustomerChange]

                        // TODO: Deduplicate code below by refactoring it to external function. Is it possible ?
                        let paramName = "request";
                        let inputDefinition: Definition = null; // default type
                        if (method.input) {
                            if (method.input.$name) {
                                paramName = method.input.$name;
                            }
                            const inputMessage = wsdl.definitions.messages[method.input.$name];
                            if (inputMessage.element) {
                                // TODO: if $type not defined, inline type into function declartion
                                const typeName =
                                    inputMessage.element.$type ?? inputMessage.element.$name;
                                const type = parsedWsdl.findDefinition(
                                    inputMessage.element.$type ?? inputMessage.element.$name
                                );
                                inputDefinition = type
                                    ? type
                                    : parseDefinition(
                                          parsedWsdl,
                                          wsdl,
                                          options,
                                          typeName,
                                          inputMessage.parts,
                                          [typeName],
                                          visitedDefinitions
                                      );
                            } else if (inputMessage.parts) {
                                const typeName = inputMessage.$name;
                                inputDefinition = parseDefinition(
                                    parsedWsdl,
                                    wsdl,
                                    options,
                                    typeName,
                                    inputMessage.parts,
                                    [typeName],
                                    visitedDefinitions
                                );
                            }
                        }

                        let outputDefinition: Definition = null; // default type
                        if (method.output) {
                            const outputMessage = wsdl.definitions.messages[method.output.$name];
                            if (outputMessage.element) {
                                // TODO: if input doesn't have $type, use $name for definition file
                                const typeName =
                                    outputMessage.element.$type ?? outputMessage.element.$name;
                                const type = parsedWsdl.findDefinition(typeName);
                                outputDefinition = type
                                    ? type
                                    : parseDefinition(
                                          parsedWsdl,
                                          wsdl,
                                          options,
                                          typeName,
                                          outputMessage.parts,
                                          [typeName],
                                          visitedDefinitions
                                      );
                            } else if (outputMessage.parts) {
                                const typeName = outputMessage.$name;
                                outputDefinition = parseDefinition(
                                    parsedWsdl,
                                    wsdl,
                                    options,
                                    typeName,
                                    outputMessage.parts,
                                    [typeName],
                                    visitedDefinitions
                                );
                            }
                        }

                        const camelParamName = camelCase(paramName);
                        const portMethod: Method = {
                            name: methodName,
                            paramName: reservedKeywords.includes(camelParamName)
                                ? `${camelParamName}Param`
                                : camelParamName,
                            paramDefinition: inputDefinition, // TODO: Use string from generated definition files
                            returnDefinition: outputDefinition, // TODO: Use string from generated definition files
                        };
                        portMethods.push(portMethod);
                        allMethods.push(portMethod);
                    }

                    const servicePort: Port = {
                        name: camelCase(portName, { pascalCase: true }),
                        sourceName: portName,
                        methods: portMethods,
                    };
                    servicePorts.push(servicePort);
                    allPorts.push(servicePort);
                } // End of Port cycle

                services.push({
                    name: camelCase(serviceName, { pascalCase: true }),
                    sourceName: serviceName,
                    ports: servicePorts,
                });
            } // End of Service cycle
            parsedWsdl.services = services;
            parsedWsdl.ports = allPorts;

            return resolve(parsedWsdl);
        });
    });
}
