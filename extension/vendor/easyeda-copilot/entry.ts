/**
 * Glue for the vendored EasyEDA Copilot MCP client (not part of the upstream sources).
 *
 * Mirrors upstream `extension/src/index.ts` without the Vue interface: it publishes the
 * helper functions some Copilot modules read from `eda`, and exposes the MCP scan controls.
 * With this loaded, the easyeda-copilot-mcp server talks to EasyEDA through the
 * EasyEDA MCP Bridge extension, so the separate EasyEDA Copilot extension is not needed.
 */
import '@copilot/shared/types/eda';
import { assembleCircuit } from './src/eda/assemble';
import { assembleBoard } from './src/eda/pcb-assemble';
import { getAsmCircuit, getSchematic } from './src/eda/schematic';
import { getPcb, getPcbRaw } from './src/eda/pcb';
import { searchComponentInSCH } from './src/eda/search';
import { checkpointer } from './src/eda/checkpointer';
import { checkPcbDrc } from './src/eda/drc';
import { getLibraryUuidList } from './src/eda/place-component';
import { startMcpScanOnStartup, toggleMcpScan } from './src/mcp-client';
import extension from './extension.json';

export const COPILOT_CLIENT_VERSION: string = extension.version;

export function startCopilotClient(): void {
	eda.assembleCircuit = assembleCircuit;
	eda.assembleBoard = assembleBoard;
	eda.getSchematic = getSchematic;
	eda.getPcb = getPcb;
	eda.getPcbRaw = getPcbRaw;
	eda.getAsmCircuit = getAsmCircuit;
	eda.searchComponentInSCH = searchComponentInSCH;
	eda.checkpointer = checkpointer;
	eda.checkPcbDrc = checkPcbDrc;
	eda.getLibraryUuidList = getLibraryUuidList;
	startMcpScanOnStartup();
}

export function toggleCopilotClient(): void {
	toggleMcpScan();
}
