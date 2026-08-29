/*
 * AppScreen MCP Bridge
 *
 * A stable, scriptable automation surface for the App Store Screenshot Generator.
 * This file intentionally sits on top of the existing vanilla-JS app instead of
 * duplicating rendering/export logic. MCP clients call these functions through
 * the browser context.
 * 
 * Copyright (c) 2026 Kaan Gönüldinc. All rights reserved.
 * 
 * Use of this source code is governed by the MIT license that can be found in the LICENSE file in the root of the source tree.
 */
(function () {
    'use strict';

    const VERSION = '1.0.2';
    const IMAGE_LOAD_TIMEOUT_MS = 30_000;
    const RENDER_SETTLE_MS = 150;

    const knownOutputDevices = [
        'iphone-6.9', 'iphone-6.7', 'iphone-6.5', 'iphone-5.5',
        'ipad-13', 'ipad-12.9', 'ipad-11',
        'android-phone', 'android-phone-hd', 'android-tablet-7', 'android-tablet-10',
        'web-og', 'web-twitter', 'web-hero', 'web-feature', 'custom'
    ];

    const knownBackgroundTypes = ['gradient', 'solid', 'image'];
    const knownTextPositions = ['top', 'center', 'bottom'];
    const knownElementTypes = ['image', 'text', 'emoji', 'icon'];

    function assertReady() {
        if (typeof state === 'undefined') {
            throw new Error('App state is not initialized yet. Load index.html before using AppScreenMCP.');
        }
        if (typeof updateCanvas !== 'function') {
            throw new Error('Renderer is not initialized yet.');
        }
    }

    function clonePlain(value) {
        return JSON.parse(JSON.stringify(value, (_key, current) => {
            if (current instanceof HTMLImageElement) {
                return undefined;
            }
            return current;
        }));
    }

    function stripRuntimeImages(screenshot) {
        const copy = clonePlain(screenshot);
        if (!copy) return copy;
        delete copy.image;
        if (copy.localizedImages) {
            Object.keys(copy.localizedImages).forEach((lang) => {
                if (copy.localizedImages[lang]) {
                    delete copy.localizedImages[lang].image;
                }
            });
        }
        if (Array.isArray(copy.elements)) {
            copy.elements.forEach((element) => {
                delete element.img;
            });
        }
        return copy;
    }

    function ok(extra = {}) {
        return { ok: true, ...extra };
    }

    function fail(error) {
        return {
            ok: false,
            error: error && error.message ? error.message : String(error)
        };
    }

    function deepMerge(target, patch) {
        if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return target;
        Object.entries(patch).forEach(([key, value]) => {
            if (value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof HTMLImageElement)) {
                if (!target[key] || typeof target[key] !== 'object' || Array.isArray(target[key])) {
                    target[key] = {};
                }
                deepMerge(target[key], value);
            } else {
                target[key] = value;
            }
        });
        return target;
    }

    function ensureIndex(index = state.selectedIndex) {
        const numeric = Number(index);
        if (!Number.isInteger(numeric) || numeric < 0 || numeric >= state.screenshots.length) {
            throw new Error(`Invalid screenshot index ${index}. Current screenshot count: ${state.screenshots.length}.`);
        }
        return numeric;
    }

    function ensureScreenshot(index = state.selectedIndex) {
        const i = ensureIndex(index);
        const screenshot = state.screenshots[i];
        if (!screenshot) throw new Error(`Screenshot ${i} does not exist.`);
        screenshot.background ||= clonePlain(state.defaults.background);
        screenshot.screenshot ||= clonePlain(state.defaults.screenshot);
        screenshot.text = normalizeTextSettings(screenshot.text || clonePlain(state.defaults.text));
        screenshot.elements ||= [];
        screenshot.popouts ||= [];
        return screenshot;
    }

    function selectedScreenshot() {
        if (state.screenshots.length === 0) throw new Error('No screenshots exist. Upload or create a screenshot first.');
        return ensureScreenshot(state.selectedIndex);
    }

    function wait(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    function loadImageFromDataUrl(dataUrl) {
        if (!dataUrl || typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) {
            return Promise.reject(new Error('Expected a data:image/* data URL.'));
        }

        return new Promise((resolve, reject) => {
            const img = new Image();
            const timer = setTimeout(() => reject(new Error('Timed out while loading image data URL.')), IMAGE_LOAD_TIMEOUT_MS);
            img.onload = () => {
                clearTimeout(timer);
                resolve(img);
            };
            img.onerror = () => {
                clearTimeout(timer);
                reject(new Error('Failed to decode image data URL.'));
            };
            img.src = dataUrl;
        });
    }

    function detectDeviceType(img) {
        if (!img || !img.width || !img.height) return 'iPhone';
        return img.width / img.height > 0.65 ? 'iPad' : 'iPhone';
    }

    function detectLangFromName(name) {
        if (typeof detectLanguageFromFilename === 'function') {
            return detectLanguageFromFilename(name || '') || null;
        }
        const lower = String(name || '').toLowerCase();
        const known = ['en', 'de', 'fr', 'es', 'it', 'pt', 'tr', 'nl', 'pl', 'ja', 'ko', 'zh'];
        return known.find((lang) => lower.includes(`_${lang}.`) || lower.includes(`-${lang}.`) || lower.endsWith(`_${lang}`) || lower.endsWith(`-${lang}`)) || null;
    }

    function refresh({ save = true, ui = true, canvas = true } = {}) {
        if (ui) {
            if (typeof syncUIWithState === 'function') syncUIWithState();
            if (typeof updateScreenshotList === 'function') updateScreenshotList();
            if (typeof updateGradientStopsUI === 'function') updateGradientStopsUI();
            if (typeof updateProjectSelector === 'function') updateProjectSelector();
            if (typeof updateElementsList === 'function') updateElementsList();
            if (typeof updatePopoutsList === 'function') updatePopoutsList();
        }
        if (canvas && typeof updateCanvas === 'function') updateCanvas();
        if (save && typeof saveState === 'function') saveState();
    }

    async function settleRender() {
        updateCanvas();
        await wait(RENDER_SETTLE_MS);
    }

    function normalizeLanguageTextMap(value, fallbackLang = 'en') {
        if (value == null) return {};
        if (typeof value === 'string') return { [fallbackLang]: value };
        if (typeof value !== 'object' || Array.isArray(value)) {
            throw new Error('Expected text to be a string or a language-to-text object.');
        }
        return { ...value };
    }

    function ensureLanguages(langs) {
        (langs || []).forEach((lang) => {
            if (lang && !state.projectLanguages.includes(lang)) {
                if (typeof addProjectLanguage === 'function') addProjectLanguage(lang);
                else state.projectLanguages.push(lang);
            }
        });
    }

    function setTextMaps(text, { headline, subheadline, language } = {}) {
        const headlineMap = normalizeLanguageTextMap(headline, language || state.currentLanguage || 'en');
        const subheadlineMap = normalizeLanguageTextMap(subheadline, language || state.currentLanguage || 'en');
        const langs = [...new Set([...Object.keys(headlineMap), ...Object.keys(subheadlineMap)])];
        ensureLanguages(langs);

        Object.entries(headlineMap).forEach(([lang, value]) => {
            text.headlines ||= {};
            text.headlines[lang] = value;
            text.headlineLanguages ||= [];
            if (!text.headlineLanguages.includes(lang)) text.headlineLanguages.push(lang);
        });
        Object.entries(subheadlineMap).forEach(([lang, value]) => {
            text.subheadlines ||= {};
            text.subheadlines[lang] = value;
            text.subheadlineLanguages ||= [];
            if (!text.subheadlineLanguages.includes(lang)) text.subheadlineLanguages.push(lang);
        });
    }

    function setSelectedIndex(index) {
        state.selectedIndex = ensureIndex(index);
        refresh();
        return state.selectedIndex;
    }

    async function blobToDataUrl(blob) {
        return await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(reader.error || new Error('Failed to read blob.'));
            reader.readAsDataURL(blob);
        });
    }

    function base64FromDataUrl(dataUrl) {
        return String(dataUrl).replace(/^data:[^;]+;base64,/, '');
    }

    async function renderPngDataUrl(index = state.selectedIndex, lang = state.currentLanguage) {
        const originalIndex = state.selectedIndex;
        const originalLanguage = state.currentLanguage;
        const originalTextLangs = state.screenshots.map((s) => ({
            headline: s.text?.currentHeadlineLang,
            subheadline: s.text?.currentSubheadlineLang
        }));

        state.selectedIndex = ensureIndex(index);
        if (lang) {
            state.currentLanguage = lang;
            state.screenshots.forEach((s) => {
                s.text = normalizeTextSettings(s.text || clonePlain(state.defaults.text));
                s.text.currentHeadlineLang = lang;
                s.text.currentSubheadlineLang = lang;
            });
        }

        await settleRender();
        const dataUrl = canvas.toDataURL('image/png');

        state.selectedIndex = originalIndex;
        state.currentLanguage = originalLanguage;
        state.screenshots.forEach((s, i) => {
            if (s.text) {
                s.text.currentHeadlineLang = originalTextLangs[i].headline;
                s.text.currentSubheadlineLang = originalTextLangs[i].subheadline;
            }
        });
        updateCanvas();

        return dataUrl;
    }

    async function exportZipDataUrl({ languages = null, currentLanguageOnly = false } = {}) {
        if (state.screenshots.length === 0) throw new Error('No screenshots to export.');
        if (typeof JSZip === 'undefined') throw new Error('JSZip is not loaded.');

        const zip = new JSZip();
        let langs = languages && languages.length ? languages : state.projectLanguages.slice();
        if (currentLanguageOnly) langs = [state.currentLanguage];
        ensureLanguages(langs);

        for (const lang of langs) {
            for (let i = 0; i < state.screenshots.length; i++) {
                const dataUrl = await renderPngDataUrl(i, lang);
                const path = langs.length > 1 ? `${lang}/screenshot-${i + 1}.png` : `screenshot-${i + 1}.png`;
                zip.file(path, base64FromDataUrl(dataUrl), { base64: true });
            }
        }

        const blob = await zip.generateAsync({ type: 'blob' });
        return await blobToDataUrl(blob);
    }

    async function invoke(name, fn) {
        try {
            assertReady();
            if (window.__APPSCREEN_INIT_PROMISE) {
                await window.__APPSCREEN_INIT_PROMISE;
            }
            const result = await fn();
            return result && result.ok === true ? result : ok({ result });
        } catch (error) {
            console.error(`[AppScreenMCP] ${name} failed:`, error);
            return fail(error);
        }
    }

    window.AppScreenMCP = {
        version: VERSION,

        async health() {
            return invoke('health', async () => ({
                version: VERSION,
                screenshotCount: state.screenshots.length,
                currentProjectId,
                outputDevice: state.outputDevice,
                languages: state.projectLanguages.slice(),
                ready: true
            }));
        },

        async getCapabilities() {
            return invoke('getCapabilities', async () => ({
                outputDevices: knownOutputDevices.slice(),
                backgroundTypes: knownBackgroundTypes.slice(),
                textPositions: knownTextPositions.slice(),
                elementTypes: knownElementTypes.slice(),
                supports: {
                    projects: true,
                    localizedScreenshots: true,
                    multilingualText: true,
                    pngExport: true,
                    zipExport: true,
                    gradientBackgrounds: true,
                    imageBackgrounds: true,
                    twoDimensionalMockups: true,
                    threeDimensionalMockups: true,
                    multipleDeviceInstancesPerScreenshot: true,
                    elements: true,
                    popouts: true,
                    aiTranslationViaAppSettings: true,
                    batchScreenshotSetCreation: true,
                    editorPreviewCaptureViaMcpServer: true,
                }
            }));
        },

        async getState({ includeScreenshots = true } = {}) {
            return invoke('getState', async () => ({
                currentProjectId,
                projects: clonePlain(projects),
                selectedIndex: state.selectedIndex,
                outputDevice: state.outputDevice,
                customWidth: state.customWidth,
                customHeight: state.customHeight,
                currentLanguage: state.currentLanguage,
                projectLanguages: state.projectLanguages.slice(),
                defaults: clonePlain(state.defaults),
                screenshots: includeScreenshots ? state.screenshots.map(stripRuntimeImages) : undefined
            }));
        },

        async createProject({ name }) {
            return invoke('createProject', async () => {
                if (!name) throw new Error('Project name is required.');
                await createProject(name);
                return { id: currentProjectId, name };
            });
        },

        async importPortableProject({ project }) {
            return invoke('importPortableProject', async () => {
                if (!project || typeof project !== 'object') {
                    throw new Error('A portable AppScreen project object is required.');
                }
                if (!db) throw new Error('The project database is not ready.');

                const dump = normalizeProjectImport(project);
                const currentRecord = dump.meta?.find(record => record.key === 'currentProject');
                const importedProjectId = currentRecord?.value;
                if (!importedProjectId) throw new Error('The imported project has no project id.');
                const previousProjectId = currentProjectId;

                for (const storeName of Object.keys(dump)) {
                    if (!db.objectStoreNames.contains(storeName)) continue;
                    const tx = db.transaction(storeName, 'readwrite');
                    const store = tx.objectStore(storeName);
                    for (const record of dump[storeName]) store.put(record);
                    await new Promise((resolve, reject) => {
                        tx.oncomplete = resolve;
                        tx.onerror = () => reject(tx.error);
                    });
                }

                await loadProjectsMeta();
                // loadProjectsMeta adopts the imported id immediately. Restore the
                // previous id so switchProject does not save the old in-memory
                // state over the newly imported database record.
                currentProjectId = previousProjectId;
                await switchProject(importedProjectId);
                return {
                    id: currentProjectId,
                    screenshotCount: state.screenshots.length,
                    languages: state.projectLanguages.slice()
                };
            });
        },

        async switchProject({ projectId }) {
            return invoke('switchProject', async () => {
                if (!projects.some((p) => p.id === projectId)) throw new Error(`Unknown project id: ${projectId}`);
                await switchProject(projectId);
                return { id: currentProjectId };
            });
        },

        async renameProject({ name }) {
            return invoke('renameProject', async () => {
                if (!name) throw new Error('Project name is required.');
                renameProject(name);
                refresh();
                return { id: currentProjectId, name };
            });
        },

        async duplicateProject({ sourceProjectId, name }) {
            return invoke('duplicateProject', async () => {
                await duplicateProject(sourceProjectId || currentProjectId, name);
                return { projects: clonePlain(projects) };
            });
        },

        async deleteCurrentProject() {
            return invoke('deleteCurrentProject', async () => {
                await deleteProject();
                return { currentProjectId, projects: clonePlain(projects) };
            });
        },

        async setOutputSize({ device, width, height }) {
            return invoke('setOutputSize', async () => {
                if (!knownOutputDevices.includes(device)) throw new Error(`Unknown output device: ${device}`);
                state.outputDevice = device;
                if (device === 'custom') {
                    const w = Number(width);
                    const h = Number(height);
                    if (!Number.isFinite(w) || !Number.isFinite(h) || w < 1 || h < 1) {
                        throw new Error('Custom output size requires positive width and height.');
                    }
                    state.customWidth = Math.round(w);
                    state.customHeight = Math.round(h);
                }
                refresh();
                return { outputDevice: state.outputDevice, dimensions: getCanvasDimensions() };
            });
        },

        async setLanguages({ languages, currentLanguage }) {
            return invoke('setLanguages', async () => {
                if (!Array.isArray(languages) || languages.length === 0) throw new Error('languages must be a non-empty array.');
                ensureLanguages(languages);
                state.projectLanguages = [...new Set(languages)];
                if (currentLanguage) state.currentLanguage = currentLanguage;
                if (!state.projectLanguages.includes(state.currentLanguage)) state.currentLanguage = state.projectLanguages[0];
                refresh();
                return { languages: state.projectLanguages.slice(), currentLanguage: state.currentLanguage };
            });
        },

        async selectScreenshot({ index }) {
            return invoke('selectScreenshot', async () => ({ selectedIndex: setSelectedIndex(index) }));
        },

        async addBlankScreenshot({ name = 'Blank Screen', language = null, deviceType = null } = {}) {
            return invoke('addBlankScreenshot', async () => {
                createNewScreenshot(null, null, name, language, deviceType || state.outputDevice);
                state.selectedIndex = state.screenshots.length - 1;
                refresh();
                return { index: state.selectedIndex, screenshot: stripRuntimeImages(state.screenshots[state.selectedIndex]) };
            });
        },

        async addScreenshotFromDataUrl({ dataUrl, name = 'screenshot.png', language = null, deviceType = null, replaceIndex = null } = {}) {
            return invoke('addScreenshotFromDataUrl', async () => {
                const img = await loadImageFromDataUrl(dataUrl);
                const lang = language || detectLangFromName(name) || state.currentLanguage || 'en';
                const resolvedDeviceType = deviceType || detectDeviceType(img);

                if (replaceIndex !== null && replaceIndex !== undefined) {
                    const target = ensureScreenshot(replaceIndex);
                    target.localizedImages ||= {};
                    target.localizedImages[lang] = { image: img, src: dataUrl, name };
                    target.image = img;
                    target.name = name;
                    target.deviceType = resolvedDeviceType;
                    state.selectedIndex = Number(replaceIndex);
                } else {
                    createNewScreenshot(img, dataUrl, name, lang, resolvedDeviceType);
                    state.selectedIndex = state.screenshots.length - 1;
                }

                ensureLanguages([lang]);
                refresh();
                return { index: state.selectedIndex, language: lang, deviceType: resolvedDeviceType };
            });
        },

        async setLocalizedScreenshotImage({ index = state.selectedIndex, language, dataUrl, name = 'localized-screenshot.png', deviceType = null } = {}) {
            return invoke('setLocalizedScreenshotImage', async () => {
                const s = ensureScreenshot(index);
                if (!language) throw new Error('language is required.');
                const img = await loadImageFromDataUrl(dataUrl);
                s.localizedImages ||= {};
                s.localizedImages[language] = { image: img, src: dataUrl, name };
                if (!s.image) s.image = img;
                s.deviceType = deviceType || s.deviceType || detectDeviceType(img);
                ensureLanguages([language]);
                state.selectedIndex = Number(index);
                refresh();
                return { index: state.selectedIndex, language };
            });
        },

        async setSecondaryDevice({ index = state.selectedIndex, device } = {}) {
            return invoke('setSecondaryDevice', async () => {
                const s = ensureScreenshot(index);
                if (!device?.screenshot) throw new Error('Secondary device settings are required.');
                const localizedImages = {};
                for (const [language, localized] of Object.entries(device.localizedImages || {})) {
                    const source = localized?.src || localized?.dataUrl;
                    if (!source) continue;
                    const img = await loadImageFromDataUrl(source);
                    localizedImages[language] = {
                        image: img,
                        src: source,
                        name: localized.name || 'Device 2 content'
                    };
                    ensureLanguages([language]);
                }
                s.secondaryDevice = {
                    name: device.name || 'Device 2',
                    screenshot: clonePlain(device.screenshot),
                    localizedImages
                };
                state.selectedIndex = Number(index);
                selectedDeviceSlot = 'secondary';
                refresh();
                return { index: state.selectedIndex, secondaryDevice: stripRuntimeImages({ secondaryDevice: s.secondaryDevice }).secondaryDevice };
            });
        },

        async removeScreenshot({ index }) {
            return invoke('removeScreenshot', async () => {
                const i = ensureIndex(index);
                state.screenshots.splice(i, 1);
                state.selectedIndex = Math.min(state.selectedIndex, Math.max(0, state.screenshots.length - 1));
                refresh();
                return { screenshotCount: state.screenshots.length, selectedIndex: state.selectedIndex };
            });
        },

        async duplicateScreenshot({ index = state.selectedIndex } = {}) {
            return invoke('duplicateScreenshot', async () => {
                duplicateScreenshot(ensureIndex(index));
                refresh();
                return { screenshotCount: state.screenshots.length };
            });
        },

        async setBackground({ index = state.selectedIndex, background } = {}) {
            return invoke('setBackground', async () => {
                const s = ensureScreenshot(index);
                if (!background || typeof background !== 'object') throw new Error('background object is required.');
                if (background.type && !knownBackgroundTypes.includes(background.type)) throw new Error(`Unknown background type: ${background.type}`);
                deepMerge(s.background, background);
                state.selectedIndex = Number(index);
                refresh();
                return { background: clonePlain(s.background) };
            });
        },

        async setBackgroundImage({ index = state.selectedIndex, dataUrl, fit = 'cover', blur = 0, overlayColor = '#000000', overlayOpacity = 0 } = {}) {
            return invoke('setBackgroundImage', async () => {
                const img = await loadImageFromDataUrl(dataUrl);
                const s = ensureScreenshot(index);
                s.background.type = 'image';
                s.background.image = img;
                s.background.imageSrc = dataUrl;
                s.background.imageFit = fit;
                s.background.imageBlur = Number(blur) || 0;
                s.background.overlayColor = overlayColor;
                s.background.overlayOpacity = Number(overlayOpacity) || 0;
                state.selectedIndex = Number(index);
                refresh();
                return { background: clonePlain(s.background) };
            });
        },

        async setDeviceSettings({ index = state.selectedIndex, settings } = {}) {
            return invoke('setDeviceSettings', async () => {
                const s = ensureScreenshot(index);
                deepMerge(s.screenshot, settings || {});
                state.selectedIndex = Number(index);
                refresh();
                return { screenshot: clonePlain(s.screenshot) };
            });
        },

        async setShared3DPair({ index = state.selectedIndex, enabled = true, gapPercent = null } = {}) {
            return invoke('setShared3DPair', async () => {
                const firstIndex = ensureIndex(index);
                if (firstIndex >= state.screenshots.length - 1) {
                    throw new Error('A multi-screen device needs a following screenshot.');
                }

                const first = ensureScreenshot(firstIndex);
                const second = ensureScreenshot(firstIndex + 1);
                const currentGroupId = first.screenshot.shared3DView?.groupId;
                const currentMembers = typeof getShared3DGroupMembers === 'function'
                    ? getShared3DGroupMembers(currentGroupId).sort((a, b) => a.index - b.index)
                    : [];
                const isRequestedPair = currentMembers.length === 2
                    && currentMembers[0].index === firstIndex
                    && currentMembers[1].index === firstIndex + 1;

                if (enabled && !isRequestedPair) {
                    if (currentGroupId && typeof unlinkShared3DGroup === 'function') {
                        unlinkShared3DGroup(currentGroupId);
                    }
                    const secondGroupId = second.screenshot.shared3DView?.groupId;
                    if (secondGroupId && typeof unlinkShared3DGroup === 'function') {
                        unlinkShared3DGroup(secondGroupId);
                    }

                    state.selectedIndex = firstIndex;
                    toggleShared3DWithNext();
                } else if (!enabled && currentGroupId && typeof unlinkShared3DGroup === 'function') {
                    unlinkShared3DGroup(currentGroupId);
                }

                if (enabled && gapPercent !== null && typeof setShared3DGapPercent === 'function') {
                    state.selectedIndex = firstIndex;
                    setShared3DGapPercent(gapPercent);
                }

                state.selectedIndex = firstIndex;
                refresh();
                return {
                    enabled: Boolean(first.screenshot.shared3DView),
                    indices: [firstIndex, firstIndex + 1],
                    screenshots: [clonePlain(first.screenshot), clonePlain(second.screenshot)]
                };
            });
        },

        async applyPositionPreset({ index = state.selectedIndex, preset }) {
            return invoke('applyPositionPreset', async () => {
                state.selectedIndex = ensureIndex(index);
                applyPositionPreset(preset);
                refresh();
                return { screenshot: clonePlain(selectedScreenshot().screenshot) };
            });
        },

        async setText({ index = state.selectedIndex, headline, subheadline, settings = {}, language = null } = {}) {
            return invoke('setText', async () => {
                const s = ensureScreenshot(index);
                s.text = normalizeTextSettings(s.text);
                setTextMaps(s.text, { headline, subheadline, language });
                deepMerge(s.text, settings || {});
                if (headline !== undefined) s.text.headlineEnabled = true;
                if (subheadline !== undefined) s.text.subheadlineEnabled = true;
                const activeLanguage = language || Object.keys(normalizeLanguageTextMap(headline || subheadline || {}, state.currentLanguage))[0];
                if (activeLanguage) {
                    s.text.currentHeadlineLang = activeLanguage;
                    s.text.currentSubheadlineLang = activeLanguage;
                }
                state.selectedIndex = Number(index);
                refresh();
                return { text: clonePlain(s.text) };
            });
        },

        async addTextElement({ index = state.selectedIndex, text = 'Text', settings = {} } = {}) {
            return invoke('addTextElement', async () => {
                state.selectedIndex = ensureIndex(index);
                addTextElement();
                const element = selectedScreenshot().elements[selectedScreenshot().elements.length - 1];
                if (element) {
                    element.texts ||= {};
                    element.texts[state.currentLanguage || 'en'] = text;
                    element.text = text;
                    deepMerge(element, settings || {});
                }
                refresh();
                return { element: stripRuntimeImages({ elements: [element] }).elements[0] };
            });
        },

        async addEmojiElement({ index = state.selectedIndex, emoji = '✨', name = 'Emoji', settings = {} } = {}) {
            return invoke('addEmojiElement', async () => {
                state.selectedIndex = ensureIndex(index);
                addEmojiElement(emoji, name);
                const element = selectedScreenshot().elements[selectedScreenshot().elements.length - 1];
                if (element) deepMerge(element, settings || {});
                refresh();
                return { element: stripRuntimeImages({ elements: [element] }).elements[0] };
            });
        },

        async addIconElement({ index = state.selectedIndex, iconName = 'star', settings = {} } = {}) {
            return invoke('addIconElement', async () => {
                state.selectedIndex = ensureIndex(index);
                await addIconElement(iconName);
                const element = selectedScreenshot().elements[selectedScreenshot().elements.length - 1];
                if (element) deepMerge(element, settings || {});
                refresh();
                return { element: stripRuntimeImages({ elements: [element] }).elements[0] };
            });
        },

        async addGraphicElementFromDataUrl({ index = state.selectedIndex, dataUrl, name = 'Graphic', settings = {} } = {}) {
            return invoke('addGraphicElementFromDataUrl', async () => {
                state.selectedIndex = ensureIndex(index);
                const img = await loadImageFromDataUrl(dataUrl);
                addGraphicElement(img, dataUrl, name);
                const element = selectedScreenshot().elements[selectedScreenshot().elements.length - 1];
                if (element) deepMerge(element, settings || {});
                refresh();
                return { element: stripRuntimeImages({ elements: [element] }).elements[0] };
            });
        },

        async updateElement({ index = state.selectedIndex, id, patch } = {}) {
            return invoke('updateElement', async () => {
                const s = ensureScreenshot(index);
                const element = s.elements.find((el) => el.id === id);
                if (!element) throw new Error(`Unknown element id: ${id}`);
                deepMerge(element, patch || {});
                state.selectedIndex = Number(index);
                refresh();
                return { element: stripRuntimeImages({ elements: [element] }).elements[0] };
            });
        },

        async deleteElement({ index = state.selectedIndex, id } = {}) {
            return invoke('deleteElement', async () => {
                state.selectedIndex = ensureIndex(index);
                deleteElement(id);
                refresh();
                return { elements: stripRuntimeImages(selectedScreenshot()).elements };
            });
        },

        async addPopout({ index = state.selectedIndex, patch = {} } = {}) {
            return invoke('addPopout', async () => {
                state.selectedIndex = ensureIndex(index);
                addPopout();
                const popout = selectedScreenshot().popouts[selectedScreenshot().popouts.length - 1];
                if (popout) deepMerge(popout, patch || {});
                refresh();
                return { popout: clonePlain(popout) };
            });
        },

        async updatePopout({ index = state.selectedIndex, id, patch } = {}) {
            return invoke('updatePopout', async () => {
                const s = ensureScreenshot(index);
                const popout = s.popouts.find((p) => p.id === id);
                if (!popout) throw new Error(`Unknown popout id: ${id}`);
                deepMerge(popout, patch || {});
                state.selectedIndex = Number(index);
                refresh();
                return { popout: clonePlain(popout) };
            });
        },

        async deletePopout({ index = state.selectedIndex, id } = {}) {
            return invoke('deletePopout', async () => {
                state.selectedIndex = ensureIndex(index);
                deletePopout(id);
                refresh();
                return { popouts: clonePlain(selectedScreenshot().popouts) };
            });
        },

        async applyStyleToAll({ sourceIndex = state.selectedIndex, includeText = true, includeBackground = true, includeDevice = true, includeElements = true, includePopouts = true } = {}) {
            return invoke('applyStyleToAll', async () => {
                const source = ensureScreenshot(sourceIndex);
                state.screenshots.forEach((target, i) => {
                    if (i === Number(sourceIndex)) return;
                    if (includeBackground) target.background = clonePlain(source.background);
                    if (includeDevice) target.screenshot = clonePlain(source.screenshot);
                    if (includeText) target.text = clonePlain(source.text);
                    if (includeElements) target.elements = clonePlain(source.elements || []);
                    if (includePopouts) target.popouts = clonePlain(source.popouts || []);
                });
                refresh();
                return { screenshotCount: state.screenshots.length };
            });
        },

        async patchState({ patch } = {}) {
            return invoke('patchState', async () => {
                deepMerge(state, patch || {});
                refresh();
                return { state: await window.AppScreenMCP.getState({ includeScreenshots: false }) };
            });
        },

        async renderCurrentPng({ language = null } = {}) {
            return invoke('renderCurrentPng', async () => {
                const dataUrl = await renderPngDataUrl(state.selectedIndex, language || state.currentLanguage);
                return {
                    fileName: `screenshot-${state.selectedIndex + 1}.png`,
                    mimeType: 'image/png',
                    dataUrl,
                    base64: base64FromDataUrl(dataUrl)
                };
            });
        },

        async exportAllZip({ languages = null, currentLanguageOnly = false } = {}) {
            return invoke('exportAllZip', async () => {
                const dataUrl = await exportZipDataUrl({ languages, currentLanguageOnly });
                return {
                    fileName: `screenshots_${state.outputDevice}_${currentLanguageOnly ? state.currentLanguage : 'all-languages'}.zip`,
                    mimeType: 'application/zip',
                    dataUrl,
                    base64: base64FromDataUrl(dataUrl)
                };
            });
        },

        async createScreenshotSet({
            projectName = 'AppScreen Campaign',
            outputDevice = 'iphone-6.9',
            width = null,
            height = null,
            languages = ['en'],
            background = null,
            deviceSettings = {},
            textSettings = {},
            screenshots = [],
            exportAllLanguagesZip = true
        } = {}) {
            return invoke('createScreenshotSet', async () => {
                if (!Array.isArray(screenshots) || screenshots.length === 0) {
                    throw new Error('screenshots must be a non-empty array. Each item must include dataUrl, name, and optional localized text.');
                }

                if (!Array.isArray(languages) || languages.length === 0) {
                    throw new Error('languages must be a non-empty array, for example ["en", "de"].');
                }

                if (!knownOutputDevices.includes(outputDevice)) {
                    throw new Error(`Unknown outputDevice "${outputDevice}". Supported values: ${knownOutputDevices.join(', ')}`);
                }

                await createProject(projectName);

                ensureLanguages(languages);
                state.projectLanguages = [...new Set(languages)];
                state.currentLanguage = state.projectLanguages[0];

                state.outputDevice = outputDevice;

                if (outputDevice === 'custom') {
                    const w = Number(width);
                    const h = Number(height);

                    if (!Number.isFinite(w) || !Number.isFinite(h) || w < 1 || h < 1) {
                        throw new Error('Custom output size requires positive width and height.');
                    }

                    state.customWidth = Math.round(w);
                    state.customHeight = Math.round(h);
                }

                for (const [i, item] of screenshots.entries()) {
                    if (!item.dataUrl) {
                        throw new Error(`screenshots[${i}] is missing dataUrl. The MCP server should hydrate filePath/base64 into dataUrl before calling the bridge.`);
                    }

                    const img = await loadImageFromDataUrl(item.dataUrl);
                    const primaryLanguage = item.language || state.projectLanguages[0] || 'en';
                    const resolvedDeviceType = item.deviceType || detectDeviceType(img);
                    const name = item.name || `screenshot-${i + 1}.png`;

                    createNewScreenshot(img, item.dataUrl, name, primaryLanguage, resolvedDeviceType);

                    const newIndex = state.screenshots.length - 1;
                    const s = ensureScreenshot(newIndex);

                    if (background) {
                        deepMerge(s.background, clonePlain(background));
                    }

                    if (deviceSettings) {
                        deepMerge(s.screenshot, clonePlain(deviceSettings));
                    }

                    s.text = normalizeTextSettings(s.text);

                    const headlineMap = {};
                    const subheadlineMap = {};

                    if (item.text && typeof item.text === 'object' && !Array.isArray(item.text)) {
                        Object.entries(item.text).forEach(([lang, entry]) => {
                            if (!entry || typeof entry !== 'object') return;

                            if (typeof entry.headline === 'string') {
                                headlineMap[lang] = entry.headline;
                            }

                            if (typeof entry.subheadline === 'string') {
                                subheadlineMap[lang] = entry.subheadline;
                            }

                            if (entry.settings && typeof entry.settings === 'object') {
                                deepMerge(s.text, entry.settings);
                            }
                        });
                    }

                    if (Object.keys(headlineMap).length > 0 || Object.keys(subheadlineMap).length > 0) {
                        setTextMaps(s.text, {
                            headline: headlineMap,
                            subheadline: subheadlineMap
                        });

                        s.text.headlineEnabled = Object.keys(headlineMap).length > 0;
                        s.text.subheadlineEnabled = Object.keys(subheadlineMap).length > 0;
                    }

                    if (textSettings) {
                        deepMerge(s.text, clonePlain(textSettings));
                    }

                    s.text.currentHeadlineLang = state.currentLanguage;
                    s.text.currentSubheadlineLang = state.currentLanguage;
                }

                state.selectedIndex = 0;
                refresh();

                const response = {
                    projectId: currentProjectId,
                    screenshotCount: state.screenshots.length,
                    selectedIndex: state.selectedIndex,
                    outputDevice: state.outputDevice,
                    languages: state.projectLanguages.slice()
                };

                if (exportAllLanguagesZip) {
                    const zip = await exportZipDataUrl({ languages: state.projectLanguages });

                    return {
                        ...response,
                        fileName: `screenshots_${state.outputDevice}_all-languages.zip`,
                        mimeType: 'application/zip',
                        dataUrl: zip,
                        base64: base64FromDataUrl(zip)
                    };
                }

                return response;
            });
        },

        async runDemoCableLaunchRecipe({ screenshots, projectName = 'Cable Launch', languages = ['en', 'de'], headline, subheadline } = {}) {
            return invoke('runDemoCableLaunchRecipe', async () => {
                if (!Array.isArray(screenshots) || screenshots.length === 0) throw new Error('screenshots must contain dataUrl/name entries.');
                await createProject(projectName);
                ensureLanguages(languages);
                state.projectLanguages = [...new Set(languages)];
                state.currentLanguage = languages[0] || 'en';
                state.outputDevice = 'iphone-6.9';

                for (const item of screenshots) {
                    const img = await loadImageFromDataUrl(item.dataUrl);
                    createNewScreenshot(img, item.dataUrl, item.name || 'screenshot.png', item.language || languages[0], item.deviceType || detectDeviceType(img));
                }

                const headlineMap = headline || { en: 'Manage your 12V systems', de: 'Verwalte deine 12V-Systeme' };
                const subheadlineMap = subheadline || { en: 'Boats, RVs, batteries and circuits in one app', de: 'Boote, Wohnmobile, Batterien und Stromkreise in einer App' };

                state.screenshots.forEach((s) => {
                    s.background.type = 'gradient';
                    s.background.gradient = {
                        angle: 135,
                        stops: [
                            { color: '#2563eb', position: 0 },
                            { color: '#7c3aed', position: 100 }
                        ]
                    };
                    s.screenshot.x = 50;
                    s.screenshot.y = 60;
                    s.screenshot.scale = 70;
                    s.screenshot.rotation = 12;
                    s.screenshot.use3D = false;
                    s.text = normalizeTextSettings(s.text);
                    setTextMaps(s.text, { headline: headlineMap, subheadline: subheadlineMap });
                    s.text.headlineEnabled = true;
                    s.text.subheadlineEnabled = true;
                    s.text.position = 'top';
                    s.text.offsetY = 12;
                    s.text.currentHeadlineLang = languages[0];
                    s.text.currentSubheadlineLang = languages[0];
                });

                state.selectedIndex = 0;
                refresh();
                const zip = await exportZipDataUrl({ languages });
                return {
                    projectId: currentProjectId,
                    screenshotCount: state.screenshots.length,
                    fileName: `screenshots_${state.outputDevice}_all-languages.zip`,
                    mimeType: 'application/zip',
                    dataUrl: zip,
                    base64: base64FromDataUrl(zip)
                };
            });
        }
    };

    window.dispatchEvent(new CustomEvent('appscreen:mcp-ready', { detail: { version: VERSION } }));
})();
