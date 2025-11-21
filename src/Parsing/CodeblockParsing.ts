import { MarkdownPreviewRenderer, Plugin } from "obsidian";
import { basename } from "path";

import CodeStylerPlugin from "src/main";
import { CodeStylerTheme, EXECUTE_CODE_SUPPORTED_LANGUAGES } from "../Settings";
import { CodeBlockArgs, getArgs } from "../External/ExecuteCode/CodeBlockArgs";
import { getRef } from "src/Referencing";
import { ExtRef } from "./ReferenceParsing";

export interface CodeblockParameters {
	language: string;
	title: string;
	reference: string;
	fold: {
		enabled: boolean;
		placeholder: string;
	};
	lineNumbers: {
		alwaysEnabled: boolean;
		alwaysDisabled: boolean;
		offset: number;
	};
	lineUnwrap: {
		alwaysEnabled: boolean;
		alwaysDisabled: boolean;
		activeWrap: boolean;
	};
	highlights: {
		default: Highlights;
		alternative: Record<string, Highlights>;
	};
	ignore: boolean;
	externalReference?: ExtRef;
}

export interface Highlights {
	lineNumbers: number[];
	plainText: string[];
	regularExpressions: RegExp[];
}

interface ExternalPlugin extends Plugin {
	supportedLanguages?: string[];
	code?: (
		source: string,
		sourcePath?: string
	) => Promise<{
		start: number;
		code: string;
		language: string;
		highlight: string;
		lines: string[];
		filePath: string;
		linenumber: number;
	}>;
	analyzeHighLightLines?: (
		lines: string[],
		source: string | string[]
	) => Map<number, boolean>;
}

export async function parseCodeblockSource(
	codeSection: string[],
	plugin: CodeStylerPlugin,
	sourcePath?: string
): Promise<{
	codeblocksParameters: CodeblockParameters[];
	nested: boolean;
}> {
	// @ts-expect-error Undocumented Obsidian API
	const plugins: Record<string, ExternalPlugin> = plugin.app.plugins.plugins;
	const admonitions: boolean = "obsidian-admonition" in plugins;
	const codeblocks: string[][] = [];
	function parseCodeblockSection(codeSection: string[]): void {
		if (codeSection.length === 0) return;

		const openingCodeblockLine = getOpeningLine(codeSection);
		if (!openingCodeblockLine) return;

		const openDelimiter = /^\s*(?:>\s*)*((?:```+|~~~+)).*$/.exec(
			openingCodeblockLine
		)?.[1];
		if (!openDelimiter) return;

		const openDelimiterIndex = codeSection.indexOf(openingCodeblockLine);
		const closeDelimiterIndex = codeSection
			.slice(openDelimiterIndex + 1)
			.findIndex((line) =>
				new RegExp(
					`^\\s*(?:>\\s*)*${openDelimiter}(?!${openDelimiter[0]})$`
				).test(line)
			);
		if (
			!admonitions ||
			!/^\s*(?:>\s*)*(?:```+|~~~+) *ad-.*$/.test(openingCodeblockLine)
		)
			codeblocks.push(
				codeSection.slice(
					0,
					openDelimiterIndex + 2 + closeDelimiterIndex
				)
			);
		else
			parseCodeblockSection(
				codeSection.slice(
					openDelimiterIndex + 1,
					openDelimiterIndex + 1 + closeDelimiterIndex
				)
			);

		parseCodeblockSection(
			codeSection.slice(openDelimiterIndex + 1 + closeDelimiterIndex + 1)
		);
	}
	parseCodeblockSection(codeSection);
	return {
		codeblocksParameters: await (typeof sourcePath !== "undefined"
			? parseCodeblocks(codeblocks, plugin, plugins, sourcePath)
			: parseCodeblocks(codeblocks, plugin, plugins)),
		nested: codeblocks[0] ? !arraysEqual(codeSection, codeblocks[0]) : true,
	};
}

async function parseCodeblocks(
	codeblocks: string[][],
	plugin: CodeStylerPlugin,
	plugins: Record<string, ExternalPlugin>,
	sourcePath?: string
): Promise<CodeblockParameters[]> {
	const codeblocksParameters: CodeblockParameters[] = [];
	for (const codeblockLines of codeblocks) {
		const codeblockParameters = await (typeof sourcePath !== "undefined"
			? parseCodeblock(codeblockLines, plugin, plugins, sourcePath)
			: parseCodeblock(codeblockLines, plugin, plugins));
		if (codeblockParameters !== null)
			codeblocksParameters.push(codeblockParameters);
	}
	return codeblocksParameters;
}

async function parseCodeblock(
	lines: string[],
	plugin: CodeStylerPlugin,
	plugins: Record<string, ExternalPlugin>,
	sourcePath?: string
): Promise<CodeblockParameters | null> {
	const parameterLine = getParameterLine(lines);
	if (!parameterLine) return null;
	const codeblockParameters = parseCodeblockParameters(
		parameterLine,
		plugin.settings.currentTheme
	);

	if (
		isCodeblockIgnored(
			codeblockParameters.language,
			plugin.settings.processedCodeblocksWhitelist
		) &&
		codeblockParameters.language !== "reference"
	)
		return null;

	return await (typeof sourcePath !== "undefined"
		? pluginAdjustParameters(
				codeblockParameters,
				plugin,
				plugins,
				lines,
				sourcePath
		  )
		: pluginAdjustParameters(codeblockParameters, plugin, plugins, lines));
}

export function parseCodeblockParameters(
	parameterLine: string,
	theme: CodeStylerTheme
): CodeblockParameters {
	const codeblockParameters: CodeblockParameters = {
		language: "",
		title: "",
		reference: "",
		fold: {
			enabled: false,
			placeholder: "",
		},
		lineNumbers: {
			alwaysEnabled: false,
			alwaysDisabled: false,
			offset: 0,
		},
		lineUnwrap: {
			alwaysEnabled: false,
			alwaysDisabled: false,
			activeWrap: false,
		},
		highlights: {
			default: {
				lineNumbers: [],
				plainText: [],
				regularExpressions: [],
			},
			alternative: {},
		},
		ignore: false,
	};

	if (parameterLine.startsWith("```"))
		parameterLine = parameterLine.replace(/^```+(?=[^`]|$)/, "");
	else if (parameterLine.startsWith("~~~"))
		parameterLine = parameterLine.replace(/^~~~+(?=[^~]|$)/, "");
	else return codeblockParameters;

	const rmdMatch = /^\{(.+)\} *$/.exec(parameterLine);
	if (rmdMatch) parameterLine = rmdMatch[1];

	const languageBreak = parameterLine.indexOf(" ");
	codeblockParameters.language = parameterLine
		.slice(0, languageBreak !== -1 ? languageBreak : parameterLine.length)
		.toLowerCase();
	if (languageBreak === -1) return codeblockParameters;
	parameterLine = parameterLine.slice(languageBreak + 1);
	if (rmdMatch) parameterLine = "title:" + parameterLine;

	const parameterStrings = parameterLine.match(
		/(?:(?:ref|reference|title):(?:\[\[.*?\]\]|\[.*?\]\(.+\))|[^\s"']+|"[^"]*"|'[^']*')+/g
	);
	if (!parameterStrings) return codeblockParameters;

	parameterStrings.forEach((parameterString) =>
		parseCodeblockParameterString(
			parameterString.replace(/(?:^,|,$)/g, ""),
			codeblockParameters,
			theme
		)
	);
	return codeblockParameters;
}

async function pluginAdjustParameters(
	codeblockParameters: CodeblockParameters,
	plugin: CodeStylerPlugin,
	plugins: Record<string, ExternalPlugin>,
	lines: string[],
	sourcePath?: string
): Promise<CodeblockParameters> {
	if (codeblockParameters.language === "reference") {
		if (typeof sourcePath === "undefined")
			throw Error("Reference block has undefined sourcePath");
		codeblockParameters = await adjustReference(
			codeblockParameters,
			lines,
			sourcePath,
			plugin
		);
	} else if (codeblockParameters.language === "preview")
		codeblockParameters = await (typeof sourcePath !== "undefined"
			? pluginAdjustPreviewCode(
					codeblockParameters,
					plugins,
					lines,
					sourcePath
			  )
			: pluginAdjustPreviewCode(codeblockParameters, plugins, lines));
	else if (codeblockParameters.language === "include")
		codeblockParameters = pluginAdjustFileInclude(
			codeblockParameters,
			plugins,
			lines
		);
	else if (/run-\w*/.test(codeblockParameters.language))
		codeblockParameters = pluginAdjustExecuteCodeRun(
			codeblockParameters,
			plugin,
			plugins
		);
	codeblockParameters = pluginAdjustExecuteCode(
		codeblockParameters,
		plugins,
		lines
	);
	return codeblockParameters;
}

async function adjustReference(
	params: CodeblockParameters,
	lines: string[],
	sourcePath: string,
	plugin: CodeStylerPlugin
): Promise<CodeblockParameters> {
	const ref = await getRef(lines, sourcePath, plugin);
	if (
		!params.lineNumbers.alwaysDisabled &&
		!params.lineNumbers.alwaysEnabled
	) {
		params.lineNumbers.offset = ref.startLine - 1;
		params.lineNumbers.alwaysEnabled = ref.startLine !== 1;
	}
	if (params.title === "") {
		params.title = ref.external?.metadata?.title ?? basename(ref.path);
	}
	if (params.reference === "") {
		params.reference =
			ref.external?.metadata?.displayUrl ??
			//@ts-expect-error Undocumented Obsidian API
			plugin.app.vault.adapter.getFilePath(ref.path);
	}
	params.language = ref.language;
	params.externalReference = ref.external;
	return params;
}

async function pluginAdjustPreviewCode(
	params: CodeblockParameters,
	plugins: Record<string, ExternalPlugin>,
	lines: string[],
	sourcePath?: string
): Promise<CodeblockParameters> {
	if (
		plugins?.["obsidian-code-preview"]?.code &&
		plugins?.["obsidian-code-preview"]?.analyzeHighLightLines
	) {
		const codePreviewParams = await plugins["obsidian-code-preview"].code(
			lines.slice(1, -1).join("\n"),
			sourcePath
		);
		if (
			!params.lineNumbers.alwaysDisabled &&
			!params.lineNumbers.alwaysEnabled
		) {
			if (typeof codePreviewParams.start === "number")
				params.lineNumbers.offset = codePreviewParams.start - 1;
			params.lineNumbers.alwaysEnabled = Boolean(
				codePreviewParams.linenumber
			);
		}
		params.highlights.default.lineNumbers = [
			...new Set(
				params.highlights.default.lineNumbers.concat(
					Array.from(
						plugins["obsidian-code-preview"].analyzeHighLightLines(
							codePreviewParams.lines,
							codePreviewParams.highlight
						),
						(pair: [number, boolean]) => pair[0]
					)
				)
			),
		];
		if (params.title === "")
			params.title =
				codePreviewParams.filePath
					.split("\\")
					.pop()
					?.split("/")
					.pop() ?? "";
		params.language = codePreviewParams.language;
	}
	return params;
}

function pluginAdjustFileInclude(
	codeblockParameters: CodeblockParameters,
	plugins: Record<string, ExternalPlugin>,
	lines: string[]
): CodeblockParameters {
	if ("file-include" in plugins) {
		const fileIncludeLanguage = /include (\w+)/.exec(lines[0])?.[1];
		if (typeof fileIncludeLanguage !== "undefined")
			codeblockParameters.language = fileIncludeLanguage;
	}
	return codeblockParameters;
}

function pluginAdjustExecuteCode(
	params: CodeblockParameters,
	plugins: Record<string, ExternalPlugin>,
	codeblockLines: string[]
): CodeblockParameters {
	if ("execute-code" in plugins) {
		const codeblockArgs: CodeBlockArgs = getArgs(codeblockLines[0]);
		params.title = params.title ?? codeblockArgs?.label ?? "";
	}
	return params;
}

function pluginAdjustExecuteCodeRun(
	params: CodeblockParameters,
	plugin: CodeStylerPlugin,
	plugins: Record<string, ExternalPlugin>
): CodeblockParameters {
	if ("execute-code" in plugins) {
		if (
			EXECUTE_CODE_SUPPORTED_LANGUAGES.includes(
				params.language.slice(4)
			) &&
			!isCodeblockIgnored(
				params.language,
				plugin.settings.processedCodeblocksWhitelist
			)
		) {
			params.language = params.language.slice(4);
		}
	}
	return params;
}

function parseCodeblockParameterString(
	parameterString: string,
	params: CodeblockParameters,
	theme: CodeStylerTheme
): void {
	if (parameterString === "ignore") params.ignore = true;
	else if (/^title[:=]/.test(parameterString))
		manageTitle(parameterString, params);
	else if (
		/^ref[:=]/.test(parameterString) ||
		/^reference[:=]/.test(parameterString)
	)
		manageReference(parameterString, params);
	else if (/^fold[:=]?/.test(parameterString))
		manageFolding(parameterString, params);
	else if (/^ln[:=]/.test(parameterString))
		manageLineNumbering(parameterString, params);
	else if (/^unwrap[:=]?/.test(parameterString) || parameterString === "wrap")
		manageWrapping(parameterString, params);
	else addHighlights(parameterString, params, theme);
}

function manageTitle(parameterString: string, params: CodeblockParameters) {
	const titleMatch = /(["']?)([^\0x1]+)\1/.exec(
		parameterString.slice("title:".length)
	);
	if (titleMatch) params.title = titleMatch[2].trim();
	parameterString = parameterString.slice("title:".length);
	const linkInfo = manageLink(parameterString);
	if (linkInfo) {
		params.title = linkInfo.title;
		params.reference = linkInfo.reference;
	}
}

function manageReference(parameterString: string, params: CodeblockParameters) {
	parameterString = parameterString.slice(
		(/^ref[:=]/.test(parameterString) ? "ref:" : "reference:").length
	);
	const linkInfo = manageLink(parameterString);
	if (linkInfo) {
		params.reference = linkInfo.reference;
		if (params.title === "") params.title = linkInfo.title;
	}
}

export function manageLink(
	parameterString: string
): { title: string; reference: string } | undefined {
	const refWikiMatch = /\[\[([^\]|\r\n]+?)(?:\|([^\]|\r\n]+?))?\]\]/.exec(
		parameterString
	);
	const refMdMatch = /\[(.*?)\]\((.+)\)/.exec(parameterString);
	const urlMatch = /^(["']?)(https?:\/\/.*)\1$/.exec(parameterString);
	let title = "";
	let reference = "";
	if (refWikiMatch) {
		title = refWikiMatch[2]
			? refWikiMatch[2].trim()
			: refWikiMatch[1].trim();
		reference = refWikiMatch[1].trim();
	} else if (refMdMatch) {
		title = refMdMatch[1].trim();
		reference = refMdMatch[2].trim();
	} else if (urlMatch) {
		title = "URL";
		reference = urlMatch[2].trim();
	} else return;
	return { title: title, reference: reference };
}

function manageFolding(parameterString: string, params: CodeblockParameters) {
	if (parameterString === "fold") {
		params.fold = {
			enabled: true,
			placeholder: "",
		};
	} else {
		const foldPlaceholderMatch = /(["']?)([^\0x1]+)\1/.exec(
			parameterString.slice("fold:".length)
		);
		if (foldPlaceholderMatch) {
			params.fold = {
				enabled: true,
				placeholder: foldPlaceholderMatch[2].trim(),
			};
		}
	}
}

function manageLineNumbering(
	parameterString: string,
	params: CodeblockParameters
) {
	parameterString = parameterString.slice("ln:".length);
	if (/^\d+$/.test(parameterString)) {
		params.lineNumbers = {
			alwaysEnabled: true,
			alwaysDisabled: false,
			offset: parseInt(parameterString) - 1,
		};
	} else if (parameterString.toLowerCase() === "true") {
		params.lineNumbers = {
			alwaysEnabled: true,
			alwaysDisabled: false,
			offset: 0,
		};
	} else if (parameterString.toLowerCase() === "false") {
		params.lineNumbers = {
			alwaysEnabled: false,
			alwaysDisabled: true,
			offset: 0,
		};
	}
}

function manageWrapping(
	parameterString: string,
	codeblockParameters: CodeblockParameters
) {
	if (parameterString === "wrap") {
		codeblockParameters.lineUnwrap = {
			alwaysEnabled: false,
			alwaysDisabled: true,
			activeWrap: false,
		};
	} else if (parameterString === "unwrap") {
		codeblockParameters.lineUnwrap = {
			alwaysEnabled: true,
			alwaysDisabled: false,
			activeWrap: false,
		};
	} else {
		parameterString = parameterString.slice("unwrap:".length);
		if (parameterString.toLowerCase() === "inactive") {
			codeblockParameters.lineUnwrap = {
				alwaysEnabled: true,
				alwaysDisabled: false,
				activeWrap: true,
			};
		} else if (parameterString.toLowerCase() === "true") {
			codeblockParameters.lineUnwrap = {
				alwaysEnabled: true,
				alwaysDisabled: false,
				activeWrap: false,
			};
		} else if (parameterString.toLowerCase() === "false") {
			codeblockParameters.lineUnwrap = {
				alwaysEnabled: false,
				alwaysDisabled: true,
				activeWrap: false,
			};
		}
	}
}

function addHighlights(
	parameterString: string,
	codeblockParameters: CodeblockParameters,
	theme: CodeStylerTheme
) {
	const highlightMatch = /^(\w+)[:=](.+)$/.exec(parameterString);
	if (highlightMatch) {
		if (highlightMatch[1] === "hl")
			codeblockParameters.highlights.default = parseHighlightedLines(
				highlightMatch[2]
			);
		else if (
			highlightMatch[1] in
			theme.colours.light.highlights.alternativeHighlights
		)
			codeblockParameters.highlights.alternative[highlightMatch[1]] =
				parseHighlightedLines(highlightMatch[2]);
	} else if (/^{[\d-,]+}$/.test(parameterString))
		codeblockParameters.highlights.default = parseHighlightedLines(
			parameterString.slice(1, -1)
		);
}

function parseHighlightedLines(highlightedLinesString: string): Highlights {
	const highlightRules = highlightedLinesString.split(",");
	const lineNumbers: Set<number> = new Set();
	const plainText: Set<string> = new Set();
	const regularExpressions: Set<RegExp> = new Set();
	highlightRules.forEach((highlightRule) => {
		if (/\d+-\d+/.test(highlightRule)) {
			// Number Range
			const [start, end] = highlightRule
				.split("-")
				.map((num) => parseInt(num));
			if (start && end && start <= end)
				Array.from(
					{ length: end - start + 1 },
					(_, num) => num + start
				).forEach((lineNumber) => lineNumbers.add(lineNumber));
		} else if (/^\/(.*)\/$/.test(highlightRule)) {
			// Regex
			try {
				regularExpressions.add(
					new RegExp(highlightRule.replace(/^\/(.*)\/$/, "$1"))
				);
			} catch {
				//pass
			}
		} else if (/".*"/.test(highlightRule))
			// Plain Text
			plainText.add(highlightRule.substring(1, highlightRule.length - 1));
		else if (/'.*'/.test(highlightRule))
			// Plain Text
			plainText.add(highlightRule.substring(1, highlightRule.length - 1));
		else if (/\D/.test(highlightRule))
			// Plain Text //TODO (@mayurankv) Should this be \D+ ??
			plainText.add(highlightRule);
		else if (/\d+/.test(highlightRule))
			// Plain Number
			lineNumbers.add(parseInt(highlightRule));
	});
	return {
		lineNumbers: [...lineNumbers],
		plainText: [...plainText],
		regularExpressions: [...regularExpressions],
	};
}

export function isLanguageIgnored(
	language: string,
	excludedLanguagesString: string
): boolean {
	return parseRegexExcludedLanguages(excludedLanguagesString).some(
		(regexExcludedLanguage) => regexExcludedLanguage.test(language)
	);
}

export function isCodeblockIgnored(
	language: string,
	whitelistedCodeblocksString: string
): boolean {
	return (
		//@ts-expect-error Undocumented Obsidian API
		language in MarkdownPreviewRenderer.codeBlockPostProcessors &&
		!parseRegexExcludedLanguages(whitelistedCodeblocksString).some(
			(regexExcludedLanguage) => regexExcludedLanguage.test(language)
		)
	);
}

function parseRegexExcludedLanguages(
	excludedLanguagesString: string
): RegExp[] {
	return excludedLanguagesString
		.split(",")
		.map(
			(regexLanguage) =>
				new RegExp(
					`^${regexLanguage.trim().replace(/\*/g, ".+")}$`,
					"i"
				)
		);
}

function getParameterLine(codeblockLines: string[]): string | undefined {
	let openingCodeblockLine = getOpeningLine(codeblockLines);
	if (
		openingCodeblockLine &&
		(openingCodeblockLine !== codeblockLines[0] ||
			/>\s*(?:[`~])/.test(openingCodeblockLine))
	)
		openingCodeblockLine = cleanParameterLine(openingCodeblockLine);
	return openingCodeblockLine;
}

function getOpeningLine(codeblockLines: string[]): string | undefined {
	return codeblockLines.find((line: string) =>
		Boolean(testOpeningLine(line))
	);
}

export function testOpeningLine(codeblockLine: string): string {
	const lineMatch = /^(\s*(?:>\s*)*)(```+|~~~+)/.exec(codeblockLine);
	if (!lineMatch) return "";
	if (
		codeblockLine.indexOf(
			lineMatch[2],
			lineMatch[1].length + lineMatch[2].length + 1
		) === -1
	)
		return lineMatch[2];
	return "";
}

function cleanParameterLine(parameterLine: string): string {
	return trimParameterLine(parameterLine).replace(
		/^(?:>\s*)*(```+|~~~+)/,
		"$1"
	);
}

export function trimParameterLine(parameterLine: string): string {
	return parameterLine.trim();
}

export async function getFileContentLines(
	sourcePath: string,
	plugin: CodeStylerPlugin
): Promise<string[]> {
	return (await plugin.app.vault.adapter.read(sourcePath)).split(/\n/g);
}

function arraysEqual(array1: unknown[], array2: unknown[]): boolean {
	return (
		array1.length === array2.length &&
		array1.every((el) => array2.includes(el))
	);
}
