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
import {
    Definition,
    DefinitionProperty,
    Method,
    ParsedWsdl,
    Port,
    Service,
} from "./models/parsed-wsdl";
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

function findReferenceDefiniton(visited: Array<VisitedDefinition>, definitionParts: object) {
    return visited.find((def) => def.parts === definitionParts);
}

function getPartsOfComplexType(type: ComplexTypeElement): [string, Element][] {
    if (type.children[0] instanceof SequenceElement) {
        return type.children[0].children.map((f) => [f.$name, f]);
    } else {
        return type.children.map((f) => [f.$name, f]);
    }
}

function parseComplexType(
    parsedWsdl: ParsedWsdl,
    wsdl: WSDL,
    options: Options,
    stack: string[],
    visitedDefs: Array<VisitedDefinition>,
    name: string,
    namespace: string
): Definition {
    const split = !namespace && name.includes(":") ? name.split(":") : null;
    const ns = split
        ? wsdl.definitions.xmlns[split[0]] || split[0]
        : wsdl.definitions.xmlns[namespace] || namespace;
    if (!ns) {
        throw new Error(`parseComplexType: No namespace provided, name: ${name}`);
    }
    const defName = split ? split[1] : name;
    const type = wsdl.definitions.schemas[ns].complexTypes[defName];
    if (!type) {
        throw new Error(`parseComplexType: Complex type not found, name: ${name}, ns: ${ns}`);
    }
    const def: Definition = {
        name: `${options.modelNamePreffix}${parsedWsdl.findNonCollisionDefinitionName(defName)}${
            options.modelNameSuffix
        }`,
        sourceName: defName,
        docs: [name],
        properties: [],
        description: "",
    };

    const propsAndDocs = flatten(
        getPartsOfComplexType(type).map((p) =>
            handleProp(parsedWsdl, wsdl, options, stack, visitedDefs, p)
        )
    );

    def.properties = propsAndDocs.filter(isDefProp);
    def.docs = propsAndDocs.filter(isString);

    parsedWsdl.definitions.push(def);

    debugger;
    return def;
}

function flatten<T>(arr: T[][]): T[] {
    return arr.reduce(function (flat, a) {
        return flat.concat(a);
    }, []);
}

function handleProp(
    parsedWsdl: ParsedWsdl,
    wsdl: WSDL,
    options: Options,
    stack: string[],
    visitedDefs: Array<VisitedDefinition>,
    [propName, type]: [string, Element]
): (DefinitionProperty | string)[] {
    if (propName === "targetNSAlias") {
        return [`targetNSAlias \`${type}\``];
    } else if (propName === "targetNamespace") {
        return [`targetNamespace \`${type}\``];
    } else if (type instanceof ComplexContentElement) {
    } else if (type instanceof SequenceElement) {
        return flatten(
            type.children.map((e) =>
                handleProp(parsedWsdl, wsdl, options, stack, visitedDefs, [e.$name, e])
            )
        );
    } else if (propName.endsWith("[]")) {
        const stripedPropName = propName.substring(0, propName.length - 2);
        // Array of
        if (typeof type === "string") {
            // primitive type
            return [
                {
                    kind: "PRIMITIVE",
                    name: stripedPropName,
                    sourceName: propName,
                    description: type,
                    type: "string",
                    isArray: true,
                },
            ];
        } else {
            // With sub-type
            const visited = findReferenceDefiniton(visitedDefs, type);
            if (visited) {
                // By referencing already declared definition, we will avoid circular references
                return [
                    {
                        kind: "REFERENCE",
                        name: stripedPropName,
                        sourceName: propName,
                        ref: visited.definition,
                        isArray: true,
                    },
                ];
            } else {
                const subDefinition = parseDefinition(
                    parsedWsdl,
                    wsdl,
                    options,
                    stripedPropName,
                    type,
                    [...stack, propName],
                    visitedDefs
                );
                return [
                    {
                        kind: "REFERENCE",
                        name: stripedPropName,
                        sourceName: propName,
                        ref: subDefinition,
                        isArray: true,
                    },
                ];
            }
        }
    } else {
        if (typeof type === "string") {
            // primitive type
            return [
                {
                    kind: "PRIMITIVE",
                    name: propName,
                    sourceName: propName,
                    description: type,
                    type: "string",
                    isArray: false,
                },
            ];
        } else if (type instanceof ComplexTypeElement) {
            // todo find existing
            const subDefinition = parseComplexType(
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
            return [
                {
                    kind: "REFERENCE",
                    name: propName,
                    sourceName: propName,
                    ref: subDefinition,
                    isArray: false,
                },
            ];
        } else if (type instanceof ElementElement && type.$type) {
            // todo find existing
            const subDefinition = parseComplexType(
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
            return [
                {
                    kind: "REFERENCE",
                    name: propName,
                    sourceName: propName,
                    ref: subDefinition,
                    isArray: false,
                },
            ];
        } else {
            const reference = findReferenceDefiniton(visitedDefs, type);
            if (reference) {
                // By referencing already declared definition, we will avoid circular references
                return [
                    {
                        kind: "REFERENCE",
                        name: propName,
                        sourceName: propName,
                        description: "",
                        ref: reference.definition,
                        isArray: false,
                    },
                ];
            } else {
                const subDefinition = parseDefinition(
                    parsedWsdl,
                    wsdl,
                    options,
                    propName,
                    type,
                    [...stack, propName],
                    visitedDefs
                );
                return [
                    {
                        kind: "REFERENCE",
                        name: propName,
                        sourceName: propName,
                        ref: subDefinition,
                        isArray: false,
                    },
                ];
            }
        }
    }
}

function isDefProp(t: string | DefinitionProperty): t is DefinitionProperty {
    return typeof t !== "string";
}
function isString(t: string | DefinitionProperty): t is string {
    return typeof t === "string";
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

    const definition: Definition = {
        name: `${options.modelNamePreffix}${parsedWsdl.findNonCollisionDefinitionName(defName)}${
            options.modelNameSuffix
        }`,
        sourceName: defName,
        docs: [name],
        properties: [],
        description: "",
    };
    visitedDefs.push({ name: definition.name, parts: defParts, definition }); // NOTE: cache reference to this defintion globally (for avoiding circular references)

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
            const propsAndDocs = Object.entries(defParts).map((p) =>
                handleProp(parsedWsdl, wsdl, options, stack, visitedDefs, p)
            );

            definition.properties = propsAndDocs.filter(isDefProp);
            definition.docs = propsAndDocs.filter(isString);
        }
    } else {
        // TODO: Doesn't have parts :(
    }

    parsedWsdl.definitions.push(definition);

    return definition;
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
                        debugger;
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
