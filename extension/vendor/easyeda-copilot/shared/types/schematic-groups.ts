/** Compact, read-only context for one schematic page or concatenated page-local results. */
export interface SchematicGroups {
    maybe_blocks: string[];
    wires: {
        net: string | null;
        pins: string;
    }[];
    /** At most 10 short diagnostics; omitted on a complete, successful read. */
    errors?: string[];
    /** Blocks declared with the `PCB Block` component property; omitted when none. */
    declared_blocks?: {
        name: string;
        /** Space-separated references, as in maybe_blocks. */
        refs: string;
        module?: string;
        attach_to?: string;
        role?: string;
        /** Attributes omitted because members, on this page or another, declare different values. */
        conflicts?: ('module' | 'attach_to' | 'role')[];
    }[];
    /** Modules of the declared blocks (`PCB Module`); omitted when none. */
    declared_modules?: { name: string; blocks: string[] }[];
    /** At most 10 problems with the declarations only; they do not make maybe_blocks or wires incomplete. */
    declaration_errors?: SchematicDeclarationIssue[];
}

/** `code` is stable for clients; `message` is the English text for people. */
export interface SchematicDeclarationIssue {
    code: 'PCB_DECLARATION_READ' | 'PCB_DECLARATION_SECTIONS' | 'PCB_DECLARATION_CONFLICT' | 'PCB_DECLARATION_UNAVAILABLE' | 'PCB_DECLARATION_MORE';
    message: string;
    /** Physical designator, for READ and SECTIONS. */
    component?: string;
    /** Declared block name and property name, for CONFLICT. */
    block?: string;
    property?: string;
}
