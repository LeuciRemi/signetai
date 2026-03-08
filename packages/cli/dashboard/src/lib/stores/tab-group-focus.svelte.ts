/**
 * Keyboard navigation state and handlers for tab group focus management.
 *
 * Extracted from +page.svelte to keep the page shell thin.
 * All state here is module-level (singleton) since there's one page.
 */

import {
	nav,
	isEngineGroup,
	isMemoryGroup,
	setTab,
} from "$lib/stores/navigation.svelte";
import {
	focus,
	returnToSidebar,
	setFocusZone,
	focusFirstPageElement,
	SIDEBAR_ORDER,
	type SidebarFocusItem,
} from "$lib/stores/focus.svelte";
import { ts } from "$lib/stores/tasks.svelte";
import { mem } from "$lib/stores/memory.svelte";

// --- Type guards ---

function isSidebarItem(value: string): value is SidebarFocusItem {
	return (SIDEBAR_ORDER as readonly string[]).includes(value);
}

// --- Tab group arrays (ordered for arrow-key cycling) ---

export const ENGINE_TABS = ["settings", "pipeline", "predictor", "connectors", "logs"] as const;
export const MEMORY_TABS = ["memory", "timeline", "knowledge", "embeddings"] as const;

// --- State ---

export const tabFocus = $state({
	keyboardNavActive: false,
	engineFocus: "tabs" as "tabs" | "content",
	engineIndex: 0,
	memoryFocus: "tabs" as "tabs" | "content",
	memoryIndex: 0,
});

// --- Focus functions ---

export function focusEngineTab(index: number): void {
	tabFocus.engineIndex = index;
	tabFocus.engineFocus = "tabs";
	setTab(ENGINE_TABS[index]);

	const tabButton = document.querySelector(`[data-engine-tab="${ENGINE_TABS[index]}"]`);
	if (tabButton instanceof HTMLElement) {
		tabButton.focus();
	}
}

export function focusEngineContent(): void {
	tabFocus.engineFocus = "content";
	focusFirstPageElement();
}

export function focusMemoryTab(index: number): void {
	tabFocus.memoryIndex = index;
	tabFocus.memoryFocus = "tabs";
	setTab(MEMORY_TABS[index]);

	const tabButton = document.querySelector(`[data-memory-tab="${MEMORY_TABS[index]}"]`);
	if (tabButton instanceof HTMLElement) {
		tabButton.focus();
	}
}

export function focusMemoryContent(): void {
	tabFocus.memoryFocus = "content";
	focusFirstPageElement();
}

// --- Window event handlers ---

export function handleGlobalKey(e: KeyboardEvent): void {
	const activeTab = nav.activeTab;
	const target = e.target;
	if (!(target instanceof HTMLElement)) return;

	const isInputFocused =
		target.tagName === "INPUT" ||
		target.tagName === "TEXTAREA" ||
		target.isContentEditable;

	if (isInputFocused && focus.zone === "page-content") return;

	if (focus.zone === "page-content" &&
		((isEngineGroup(activeTab) && tabFocus.engineFocus === "content") ||
		 (isMemoryGroup(activeTab) && tabFocus.memoryFocus === "content"))) {
		// Already in content mode -- keep keyboardNavActive as-is
	} else {
		tabFocus.keyboardNavActive = true;
	}

	// Escape from page content
	if (focus.zone === "page-content" && e.key === "Escape") {
		if (e.defaultPrevented) return;

		const modalOpen =
			ts.formOpen ||
			ts.detailOpen ||
			mem.formOpen ||
			document.querySelector('[role="dialog"][data-state="open"]');

		if (!modalOpen) {
			e.preventDefault();
			if (isEngineGroup(activeTab) && tabFocus.engineFocus === "content") {
				focusEngineTab(tabFocus.engineIndex);
			} else if (isMemoryGroup(activeTab) && tabFocus.memoryFocus === "content") {
				focusMemoryTab(tabFocus.memoryIndex);
			} else {
				returnToSidebar();
			}
		}
	}

	// Engine tab group navigation
	if (isEngineGroup(activeTab) && focus.zone === "page-content" && !isInputFocused && !e.defaultPrevented) {
		if (tabFocus.engineFocus === "tabs") {
			if (e.key === "ArrowLeft") {
				e.preventDefault();
				if (tabFocus.engineIndex === 0) {
					returnToSidebar();
				} else {
					focusEngineTab(tabFocus.engineIndex - 1);
				}
			} else if (e.key === "ArrowRight") {
				e.preventDefault();
				focusEngineTab((tabFocus.engineIndex + 1) % ENGINE_TABS.length);
			} else if (e.key === "ArrowDown") {
				e.preventDefault();
				focusEngineContent();
			}
		} else if (tabFocus.engineFocus === "content") {
			if (e.key === "ArrowUp") {
				e.preventDefault();
				focusEngineTab(tabFocus.engineIndex);
			}
		}
	}

	// Memory tab group navigation
	if (isMemoryGroup(activeTab) && focus.zone === "page-content" && !isInputFocused && !e.defaultPrevented) {
		if (tabFocus.memoryFocus === "tabs") {
			if (e.key === "ArrowLeft") {
				e.preventDefault();
				if (tabFocus.memoryIndex === 0) {
					returnToSidebar();
				} else {
					focusMemoryTab(tabFocus.memoryIndex - 1);
				}
			} else if (e.key === "ArrowRight") {
				e.preventDefault();
				focusMemoryTab((tabFocus.memoryIndex + 1) % MEMORY_TABS.length);
			} else if (e.key === "ArrowDown") {
				e.preventDefault();
				focusMemoryContent();
			}
		} else if (tabFocus.memoryFocus === "content") {
			if (e.key === "ArrowUp") {
				e.preventDefault();
				focusMemoryTab(tabFocus.memoryIndex);
			}
		}
	}
}

export function handleFocusIn(e: FocusEvent): void {
	const activeTab = nav.activeTab;
	const target = e.target;
	if (!(target instanceof HTMLElement)) return;

	const sidebarItem = target.closest('[data-sidebar-item]');
	if (sidebarItem) {
		const rawItem = sidebarItem.getAttribute('data-sidebar-item');
		if (rawItem && isSidebarItem(rawItem) && focus.sidebarItem !== rawItem) {
			focus.zone = 'sidebar-menu';
			focus.sidebarItem = rawItem;
		}
		return;
	}

	const engineTab = target.closest('[data-engine-tab]');
	if (engineTab) {
		if (focus.zone !== 'page-content') {
			setFocusZone('page-content');
		}
		const rawTabName = engineTab.getAttribute('data-engine-tab');
		if (rawTabName === null) return;
		const index = (ENGINE_TABS as readonly string[]).indexOf(rawTabName);
		if (index !== -1) {
			tabFocus.engineIndex = index;
			tabFocus.engineFocus = "tabs";
		}
		return;
	}

	const memoryTab = target.closest('[data-memory-tab]');
	if (memoryTab) {
		if (focus.zone !== 'page-content') {
			setFocusZone('page-content');
		}
		const rawTabName = memoryTab.getAttribute('data-memory-tab');
		if (rawTabName === null) return;
		const index = (MEMORY_TABS as readonly string[]).indexOf(rawTabName);
		if (index !== -1) {
			tabFocus.memoryIndex = index;
			tabFocus.memoryFocus = "tabs";
		}
		return;
	}

	const pageContent = target.closest('[data-page-content="true"]');
	if (pageContent && focus.zone !== 'page-content') {
		setFocusZone('page-content');

		if (isEngineGroup(activeTab)) {
			const index = (ENGINE_TABS as readonly string[]).indexOf(activeTab);
			if (index !== -1) {
				tabFocus.engineIndex = index;
				const isOnTabButton = !!target.closest('[data-engine-tab]');
				tabFocus.engineFocus = isOnTabButton ? "tabs" : "content";
			}
		} else if (isMemoryGroup(activeTab)) {
			const index = (MEMORY_TABS as readonly string[]).indexOf(activeTab);
			if (index !== -1) {
				tabFocus.memoryIndex = index;
				const isOnTabButton = !!target.closest('[data-memory-tab]');
				tabFocus.memoryFocus = isOnTabButton ? "tabs" : "content";
			}
		}
		return;
	}
}

export function handlePageClick(e: MouseEvent): void {
	const activeTab = nav.activeTab;
	tabFocus.keyboardNavActive = false;

	const target = e.target;
	if (!(target instanceof HTMLElement)) return;

	const pageContent = target.closest('[data-page-content="true"]');
	if (!pageContent) return;

	if (focus.zone !== 'page-content') {
		setFocusZone('page-content');
	}

	const clickedEngineTab = target.closest('[data-engine-tab]');
	const clickedMemoryTab = target.closest('[data-memory-tab]');

	if (isEngineGroup(activeTab)) {
		const index = (ENGINE_TABS as readonly string[]).indexOf(activeTab);
		if (index !== -1) {
			tabFocus.engineIndex = index;
			tabFocus.engineFocus = clickedEngineTab ? "tabs" : "content";
		}
	} else if (isMemoryGroup(activeTab)) {
		const index = (MEMORY_TABS as readonly string[]).indexOf(activeTab);
		if (index !== -1) {
			tabFocus.memoryIndex = index;
			tabFocus.memoryFocus = clickedMemoryTab ? "tabs" : "content";
		}
	}
}

/**
 * Initialize custom event listeners for tab group focus.
 * Call from the page component's onMount. Returns a cleanup function.
 */
export function initTabGroupEffects(): () => void {
	const handleMemoryFocusTabs = () => {
		focusMemoryTab(tabFocus.memoryIndex);
	};
	const handleEngineFocusTabs = () => {
		focusEngineTab(tabFocus.engineIndex);
	};
	window.addEventListener("memory-focus-tabs", handleMemoryFocusTabs);
	window.addEventListener("engine-focus-tabs", handleEngineFocusTabs);

	return () => {
		window.removeEventListener("memory-focus-tabs", handleMemoryFocusTabs);
		window.removeEventListener("engine-focus-tabs", handleEngineFocusTabs);
	};
}
