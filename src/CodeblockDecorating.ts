import {
	LANGUAGE_NAMES,
	CodeStylerThemeSettings,
	FOLD_PLACEHOLDER,
	GIT_ICONS,
	STAMP_ICON,
	SITE_ICONS,
	UPDATE_ICON,
} from "./Settings";
import { CodeblockParameters, Highlights } from "./Parsing/CodeblockParsing";
import { InlineCodeParameters } from "./Parsing/InlineCodeParsing";
import { MarkdownRenderer, MarkdownView } from "obsidian";
import CodeStylerPlugin from "./main";
import { rerender } from "./EditingView";
import { updateExtRef } from "./Referencing";

export function createHeader(
	params: CodeblockParameters,
	themeSettings: CodeStylerThemeSettings,
	sourcePath: string,
	plugin: CodeStylerPlugin
): HTMLElement {
	const headerContainer = createDiv();
	const iconURL = params.language
		? getLanguageIcon(params.language, plugin.languageIcons)
		: undefined;
	if (!isHeaderHidden(params, themeSettings, iconURL)) {
		headerContainer.classList.add("code-styler-header-container");
		if (params.language !== "") {
			if (isLanguageIconShown(params, themeSettings, iconURL)) {
				headerContainer.appendChild(
					createImageWrapper(iconURL as string, createDiv())
				);
			}
			if (isLanguageTagShown(params, themeSettings)) {
				headerContainer.appendChild(
					createDiv({
						cls: "code-styler-header-language-tag",
						text: getLanguageTag(params.language),
					})
				);
			}
		}
		headerContainer.appendChild(
			createTitleContainer(params, themeSettings, sourcePath, plugin)
		);
		if (params?.externalReference) {
			headerContainer.appendChild(
				createExtRefContainer(params, sourcePath, plugin)
			);
		}
		if (false) {
			//TODO (@mayurankv) Add settings toggle once execute code compatibility improved
			headerContainer.appendChild(
				createExecuteCodeContainer(params, plugin)
			);
		}
	} else {
		headerContainer.classList.add("code-styler-header-container-hidden");
	}
	return headerContainer;
}

function createTitleContainer(
	params: CodeblockParameters,
	settings: CodeStylerThemeSettings,
	sourcePath: string,
	plugin: CodeStylerPlugin
): HTMLElement {
	const titleContainer = createDiv({ cls: "code-styler-header-text" });
	const title =
		params.title ||
		(params.fold.enabled
			? params.fold.placeholder ||
			  settings.header.foldPlaceholder ||
			  FOLD_PLACEHOLDER
			: "");
	if (params.reference === "") {
		titleContainer.innerText = title;
	} else if (/^(?:https?|file|zotero):\/\//.test(params.reference))
		MarkdownRenderer.render(
			plugin.app,
			`[${title}](${params.reference})`,
			titleContainer,
			sourcePath,
			plugin
		);
	else {
		MarkdownRenderer.render(
			plugin.app,
			`[[${params.reference}|${title}]]`,
			titleContainer,
			sourcePath,
			plugin
		); //TODO (@mayurankv) Add links to metadata cache properly
	}
	return titleContainer;
}

function createExtRefContainer(
	params: CodeblockParameters,
	sourcePath: string,
	plugin: CodeStylerPlugin
): HTMLElement {
	//TODO (@mayurankv) Add theme settings to conditionally set sections

	const container = createDiv({
		cls: "code-styler-header-external-reference",
	});

	const settings = plugin.settings.currentTheme.settings;
	const metadata = params?.externalReference?.metadata;

	if (settings.header.externalReference.displayRepository) {
		const icon = createDiv({ cls: "external-reference-repo-icon" });
		icon.innerHTML =
			SITE_ICONS?.[metadata?.site as string] ?? SITE_ICONS["generic"];
		container.appendChild(icon);
		container.appendChild(
			createDiv({
				cls: "external-reference-repo",
				text: metadata?.author + "/" + metadata?.repository,
			})
		);
	}

	if (settings.header.externalReference.displayVersion) {
		const icon = createDiv({ cls: "external-reference-ref-icon" });
		icon.innerHTML =
			GIT_ICONS?.[metadata?.refInfo?.type as string] ??
			GIT_ICONS["branch"];
		container.appendChild(icon);
		container.appendChild(
			createDiv({
				cls: "external-reference-ref",
				text: metadata?.refInfo?.ref as string,
			})
		);
	}

	if (settings.header.externalReference.displayTimestamp) {
		const icon = createDiv({
			cls: "external-reference-timestamp-icon",
		});
		icon.innerHTML = STAMP_ICON;
		container.appendChild(icon);
		container.appendChild(
			createDiv({
				cls: "external-reference-timestamp",
				text: metadata?.datetime as string,
			})
		);
	}

	const updateIcon = createEl("button", {
		cls: "external-reference-update-icon",
	});
	updateIcon.innerHTML = UPDATE_ICON;
	updateIcon.title = "Update Reference";
	updateIcon.addEventListener("click", async (event) => {
		if (!params?.externalReference) {
			return;
		}
		event.stopImmediatePropagation();
		await updateExtRef(params?.externalReference.params, plugin);
		const codeblockElement = (
			event.target as HTMLElement
		).parentElement?.parentElement?.parentElement?.querySelector("code");
		if (!codeblockElement) return;
		const view = plugin.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view) return;

		if (view?.getMode() === "preview") {
			codeblockElement.addClass("RERENDER-CODE-STYLER");
			//@ts-expect-error Undocumented Obsidian API
			for (const section of view.previewMode.renderer.sections.filter(
				(s: any) =>
					(s.el as HTMLElement).querySelector("RERENDER-CODE-STYLER")
			)) {
				section.rendered = false;
				section.html = "";
			}
			view?.previewMode.rerender(true);
		} else {
			//@ts-expect-error Undocumented Obsidian API
			const cmView = view?.sourceMode.cmEditor.cm;
			const pos = cmView.posAtDOM(event.target);
			const current: number = cmView.state.selection.main.head;
			cmView.dispatch({
				selection: { anchor: pos, head: pos },
				effects: rerender.of({ pos: current }),
			});
			cmView.focus();
			setTimeout(
				() =>
					cmView.dispatch({
						selection: { anchor: current, head: current },
					}),
				10
			);
		}
	});
	container.appendChild(updateIcon);
	return container;
}

function createExecuteCodeContainer(
	params: CodeblockParameters,
	plugin: CodeStylerPlugin
): HTMLElement {
	const container = createDiv({
		cls: "code-styler-header-execute-code",
	});
	console.log("Developer Error: Section not finished", params, plugin);
	//TODO (@mayurankv) Finish
	return container;
}

export function createInlineOpener(
	params: InlineCodeParameters,
	languageIcons: Record<string, string>,
	containerClasses: string[] = ["code-styler-inline-opener"]
): HTMLElement {
	const openerContainer = createSpan({ cls: containerClasses.join(" ") });
	if (params.icon) {
		const iconURL = getLanguageIcon(params.language, languageIcons);
		if (typeof iconURL !== "undefined")
			openerContainer.appendChild(
				createImageWrapper(
					iconURL,
					createSpan(),
					"code-styler-inline-icon"
				)
			);
	}
	if (params.title)
		openerContainer.appendChild(
			createSpan({
				cls: "code-styler-inline-title",
				text: params.title,
			})
		);
	return openerContainer;
}

function createImageWrapper(
	iconURL: string,
	imageWrapper: HTMLElement,
	imgClass = "code-styler-icon"
): HTMLElement {
	const img = document.createElement("img");
	img.classList.add(imgClass);
	img.src = iconURL;
	imageWrapper.appendChild(img);
	return imageWrapper;
}

export function getLanguageIcon(
	language: string,
	languageIcons: Record<string, string>
): string | undefined {
	return languageIcons?.[getLanguageTag(language)];
}

function getLanguageTag(language: string) {
	return (
		LANGUAGE_NAMES?.[language] ??
		(language.charAt(0).toUpperCase() + language.slice(1) || "")
	);
}

export function isHeaderHidden(
	params: CodeblockParameters,
	settings: CodeStylerThemeSettings,
	iconURL: string | undefined
): boolean {
	return (
		!isHeaderRequired(params) &&
		(params.language === "" ||
			(settings.header.languageTag.display !== "always" &&
				(settings.header.languageIcon.display !== "always" ||
					typeof iconURL == "undefined")))
	);
}

function isLanguageIconShown(
	params: CodeblockParameters,
	themeSettings: CodeStylerThemeSettings,
	iconURL: string | undefined
): boolean {
	return (
		typeof iconURL !== "undefined" &&
		(themeSettings.header.languageIcon.display === "always" ||
			(isHeaderRequired(params) &&
				themeSettings.header.languageIcon.display ===
					"if_header_shown"))
	);
}

function isLanguageTagShown(
	params: CodeblockParameters,
	settings: CodeStylerThemeSettings
): boolean {
	return (
		settings.header.languageTag.display === "always" ||
		(isHeaderRequired(params) &&
			settings.header.languageTag.display === "if_header_shown")
	);
}

function isHeaderRequired(params: CodeblockParameters): boolean {
	return params.fold.enabled || params.title !== "";
}

export function getLineClass(
	params: CodeblockParameters,
	lineNumber: number,
	line: string
): string[] {
	let classList: string[] = [];
	if (
		params.highlights.default.lineNumbers.includes(
			lineNumber + params.lineNumbers.offset
		) ||
		params.highlights.default.plainText.some(
			(text) => line.indexOf(text) > -1
		) ||
		params.highlights.default.regularExpressions.some((regExp) =>
			regExp.test(line)
		)
	)
		classList.push("code-styler-line-highlighted");
	Object.entries(params.highlights.alternative).forEach(
		([alternativeHighlight, highlightedLines]: [string, Highlights]) => {
			if (
				highlightedLines.lineNumbers.includes(
					lineNumber + params.lineNumbers.offset
				) ||
				highlightedLines.plainText.some(
					(text) => line.indexOf(text) > -1
				) ||
				highlightedLines.regularExpressions.some((regExp) =>
					regExp.test(line)
				)
			)
				classList.push(
					`code-styler-line-highlighted-${alternativeHighlight
						.replace(/\s+/g, "-")
						.toLowerCase()}`
				);
		}
	);
	if (classList.length === 0) {
		classList = ["code-styler-line"];
	}
	return classList;
}
