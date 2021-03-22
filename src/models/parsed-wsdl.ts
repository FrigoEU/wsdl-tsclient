import sanitizeFilename from "sanitize-filename";

export type XmlType =
    | { kind: "PRIMITIVE"; type: string }
    | { kind: "REFERENCE"; ref: string }
    | { kind: "ARRAY"; type: XmlType }
    | { kind: "MAP"; properties: { propName: string; type: XmlType }[] };

export interface Definition {
    name: string;
    sourceName: string;
    description?: string;
    docs: string[];
    type: XmlType;
}

export interface Method {
    name: string;
    paramName: string;
    paramDefinition: null | Definition;
    returnDefinition: null | Definition;
}

export interface Port {
    name: string;
    sourceName: string;
    description?: string;
    methods: Array<Method>;
}

export interface Service {
    name: string;
    sourceName: string;
    description?: string;
    ports: Array<Port>;
}

export class ParsedWsdl {
    /**
     * Name is always uppercased filename of wsdl without an extension
     * @example "MyClient"
     */
    name: string;
    wsdlFilename: string;
    wsdlPath: string;

    definitions: Array<Definition> = [];
    ports: Array<Port> = [];
    services: Array<Service> = [];

    findDefinition(definitionName: string): Definition {
        return this.definitions.find((def) => def.name === definitionName);
    }

    findNonCollisionDefinitionName(defName: string): string {
        const definitionName = sanitizeFilename(defName);
        if (!this.definitions.find((def) => def.name === definitionName)) {
            return definitionName;
        }
        for (let i = 1; i < 30; i++) {
            // TODO: Unhardcode `20`
            if (!this.definitions.find((def) => def.name === `${definitionName}${i}`)) {
                return `${definitionName}${i}`;
            }
        }
        throw new Error(`Out of stack for "${definitionName}", there's probably cyclic definition`);
    }
}
