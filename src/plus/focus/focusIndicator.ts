import type { ConfigurationChangeEvent, StatusBarItem, ThemeColor } from 'vscode';
import { Disposable, MarkdownString, StatusBarAlignment, window } from 'vscode';
import { Commands, previewBadge } from '../../constants';
import type { Container } from '../../container';
import { registerCommand } from '../../system/command';
import { configuration } from '../../system/configuration';
import { groupByMap } from '../../system/iterable';
import { pluralize } from '../../system/string';
import type { ConnectionStateChangeEvent } from '../integrations/integrationService';
import { HostingIntegrationId } from '../integrations/providers/models';
import type { FocusGroup, FocusItem, FocusProvider, FocusRefreshEvent } from './focusProvider';
import { groupAndSortFocusItems, supportedFocusIntegrations } from './focusProvider';

type FocusIndicatorState = 'idle' | 'disconnected' | 'loading' | 'load';

export class FocusIndicator implements Disposable {
	private readonly _disposable: Disposable;

	private _statusBarFocus: StatusBarItem | undefined;

	private _refreshTimer: ReturnType<typeof setInterval> | undefined;

	private _state: FocusIndicatorState;

	private _lastDataUpdate: Date | undefined;

	private _lastRefreshPaused: Date | undefined;

	constructor(
		private readonly container: Container,
		private readonly focus: FocusProvider,
	) {
		this._disposable = Disposable.from(
			window.onDidChangeWindowState(this.onWindowStateChanged, this),
			focus.onDidRefresh(this.onFocusRefreshed, this),
			configuration.onDidChange(this.onConfigurationChanged, this),
			container.integrations.onDidChangeConnectionState(this.onConnectedIntegrationsChanged, this),
			...this.registerCommands(),
		);
		this._state = 'idle';
		void this.onReady();
	}

	dispose() {
		this.clearRefreshTimer();
		this._statusBarFocus?.dispose();
		this._statusBarFocus = undefined!;
		this._disposable.dispose();
	}

	private async onConnectedIntegrationsChanged(e: ConnectionStateChangeEvent) {
		if (supportedFocusIntegrations.includes(e.key as HostingIntegrationId)) {
			await this.maybeLoadData();
		}
	}

	private async onConfigurationChanged(e: ConfigurationChangeEvent) {
		if (!configuration.changed(e, 'launchpad.indicator')) return;

		if (configuration.changed(e, 'launchpad.indicator.openInEditor')) {
			this.updateStatusBarCommand();
		}

		let reloaded = false;
		if (configuration.changed(e, 'launchpad.indicator.polling')) {
			if (configuration.changed(e, 'launchpad.indicator.polling.enabled')) {
				await this.maybeLoadData();
				reloaded = true;
			} else if (configuration.changed(e, 'launchpad.indicator.polling.interval')) {
				this.startRefreshTimer();
			}
		}

		if (
			(!reloaded && configuration.changed(e, 'launchpad.indicator.useColors')) ||
			configuration.changed(e, 'launchpad.indicator.icon') ||
			configuration.changed(e, 'launchpad.indicator.label') ||
			configuration.changed(e, 'launchpad.indicator.groups')
		) {
			await this.maybeLoadData();
			if (configuration.changed(e, 'launchpad.indicator.label')) {
				this.updateStatusBarCommand();
			}
		}
	}

	private async maybeLoadData() {
		if (
			configuration.get('launchpad.indicator.polling.enabled') &&
			configuration.get('launchpad.indicator.polling.interval') > 0
		) {
			if (await this.focus.hasConnectedIntegration()) {
				this.updateStatusBar('loading');
			} else {
				this.updateStatusBar('disconnected');
			}
		} else {
			this.updateStatusBar('idle');
		}
	}

	private onFocusRefreshed(e: FocusRefreshEvent) {
		if (this._statusBarFocus == null || !configuration.get('launchpad.indicator.polling.enabled')) return;

		this.updateStatusBar('load', e.items);
	}

	private async onReady(): Promise<void> {
		if (!configuration.get('launchpad.indicator.enabled')) return;

		this._statusBarFocus = window.createStatusBarItem('gitlens.launchpad', StatusBarAlignment.Left, 10000 - 3);
		this._statusBarFocus.name = 'GitLens Launchpad';

		await this.maybeLoadData();
		this.updateStatusBarCommand();

		this._statusBarFocus.show();
	}

	private startRefreshTimer(firstDelay?: number) {
		if (this._refreshTimer != null) {
			clearInterval(this._refreshTimer);
		}

		if (!configuration.get('launchpad.indicator.polling.enabled') || this._state === 'disconnected') return;

		const refreshInterval = configuration.get('launchpad.indicator.polling.interval') * 1000 * 60;
		if (refreshInterval <= 0) return;

		if (firstDelay != null) {
			this._refreshTimer = setTimeout(() => {
				void this.focus.getCategorizedItems({ force: true });
				this._refreshTimer = setInterval(() => {
					void this.focus.getCategorizedItems({ force: true });
				}, refreshInterval);
			}, firstDelay);
		} else {
			this._refreshTimer = setInterval(() => {
				void this.focus.getCategorizedItems({ force: true });
			}, refreshInterval);
		}
	}

	private clearRefreshTimer() {
		if (this._refreshTimer != null) {
			clearInterval(this._refreshTimer);
			this._refreshTimer = undefined;
		}
	}

	private onWindowStateChanged(e: { focused: boolean }) {
		if (this._state === 'disconnected' || this._state === 'idle') return;

		if (!e.focused) {
			this.clearRefreshTimer();
			this._lastRefreshPaused = new Date();

			return;
		}

		if (this._lastRefreshPaused == null) return;
		if (this._state === 'loading') {
			this.startRefreshTimer(5000);

			return;
		}

		const now = Date.now();
		const timeSinceLastUpdate = this._lastDataUpdate != null ? now - this._lastDataUpdate.getTime() : undefined;
		const timeSinceLastUnfocused = now - this._lastRefreshPaused.getTime();
		this._lastRefreshPaused = undefined;

		const refreshInterval = configuration.get('launchpad.indicator.polling.interval') * 1000 * 60;

		let timeToNextPoll = timeSinceLastUpdate != null ? refreshInterval - timeSinceLastUpdate : refreshInterval;
		if (timeToNextPoll < 0) {
			timeToNextPoll = 0;
		}

		const diff = timeToNextPoll - timeSinceLastUnfocused;
		this.startRefreshTimer(diff < 0 ? 0 : diff);
	}

	private updateStatusBar(state: FocusIndicatorState, categorizedItems?: FocusItem[]) {
		if (this._statusBarFocus == null) return;
		if (state === this._state && state !== 'load') return;

		this._state = state;

		const tooltip = new MarkdownString('', true);
		tooltip.supportHtml = true;
		tooltip.isTrusted = true;

		tooltip.appendMarkdown(
			`GitLens Launchpad ${previewBadge}\u00a0\u00a0\u00a0\u00a0&mdash;\u00a0\u00a0\u00a0\u00a0`,
		);
		tooltip.appendMarkdown(`[$(gear)](command:workbench.action.openSettings?%22gitlens.launchpad%22 "Settings")`);
		tooltip.appendMarkdown('\u00a0\u00a0\u00a0|\u00a0\u00a0\u00a0');
		tooltip.appendMarkdown(`[$(circle-slash) Hide](command:gitlens.launchpad.indicator.action?"hide" "Hide")`);
		tooltip.appendMarkdown('\n\n---\n\n');

		// TODO: Also add as a first-time tooltip
		if (state === 'idle' || state === 'disconnected' || state === 'loading') {
			tooltip.appendMarkdown(
				'[Launchpad](command:gitlens.getStarted?"gitlens.welcome.launchpad" "Learn about Launchpad") organizes your pull requests into actionable groups to help you focus and keep your team unblocked.',
			);
			tooltip.appendMarkdown(
				"\n\nIt's always accessible using the `GitLens: Open Launchpad` command from the Command Palette.",
			);
		}

		switch (state) {
			case 'idle':
				this.clearRefreshTimer();
				this._statusBarFocus.text = '$(rocket)';
				this._statusBarFocus.tooltip = tooltip;
				this._statusBarFocus.color = undefined;
				break;

			case 'disconnected':
				this.clearRefreshTimer();
				tooltip.appendMarkdown(
					`\n\n[Connect to GitHub](command:gitlens.launchpad.indicator.action?"connectGitHub" "Connect to GitHub") to get started.`,
				);

				this._statusBarFocus.text = `$(rocket)$(gitlens-unplug) Launchpad`;
				this._statusBarFocus.tooltip = tooltip;
				this._statusBarFocus.color = undefined;
				break;

			case 'loading':
				this.startRefreshTimer(5000);
				tooltip.appendMarkdown('\n\n---\n\n$(loading~spin) Loading...');

				this._statusBarFocus.text = '$(loading~spin)';
				this._statusBarFocus.tooltip = tooltip;
				this._statusBarFocus.color = undefined;
				break;

			case 'load':
				this.updateStatusBarWithItems(tooltip, categorizedItems);
				break;
		}
	}

	private updateStatusBarCommand() {
		if (this._statusBarFocus == null) return;

		const labelType = configuration.get('launchpad.indicator.label') ?? 'item';
		this._statusBarFocus.command = configuration.get('launchpad.indicator.openInEditor')
			? 'gitlens.showFocusPage'
			: {
					title: 'Open Launchpad',
					command: Commands.ShowLaunchpad,
					arguments: [{ source: 'indicator', state: { selectTopItem: labelType === 'item' } }],
			  };
	}

	private updateStatusBarWithItems(tooltip: MarkdownString, categorizedItems: FocusItem[] | undefined) {
		if (this._statusBarFocus == null) return;

		this.sendTelemetryFirstLoadEvent();

		this._lastDataUpdate = new Date();
		const useColors = configuration.get('launchpad.indicator.useColors');
		const groups: FocusGroup[] = configuration.get('launchpad.indicator.groups') ?? [];
		const labelType = configuration.get('launchpad.indicator.label') ?? 'item';
		const iconType = configuration.get('launchpad.indicator.icon') ?? 'default';

		let color: string | ThemeColor | undefined = undefined;
		let topItem: { item: FocusItem; groupLabel: string } | undefined;
		let topIcon: 'error' | 'comment-draft' | 'report' | 'rocket' | undefined;

		const groupedItems = groupAndSortFocusItems(categorizedItems);
		const totalGroupedItems = Array.from(groupedItems.values()).reduce((total, group) => total + group.length, 0);

		const hasImportantGroupsWithItems = groups.some(group => groupedItems.get(group)?.length);
		if (totalGroupedItems === 0) {
			tooltip.appendMarkdown('You are all caught up!');
		} else if (!hasImportantGroupsWithItems) {
			tooltip.appendMarkdown(
				`No pull requests need your attention\\\n(${totalGroupedItems} other pull requests)`,
			);
		} else {
			for (const group of groups) {
				const items = groupedItems.get(group);
				if (!items?.length) continue;

				if (tooltip.value.length > 0) {
					tooltip.appendMarkdown(`\n\n---\n\n`);
				}

				switch (group) {
					case 'mergeable': {
						topIcon ??= 'rocket';
						topItem ??= { item: items[0], groupLabel: 'can be merged' };
						tooltip.appendMarkdown(
							`<span style="color:#3d90fc;">$(rocket)</span> [${
								labelType === 'item' && topItem != null
									? this.getTopItemLabel(topItem.item, items.length)
									: pluralize('pull request', items.length)
							} can be merged](command:gitlens.showLaunchpad?${encodeURIComponent(
								JSON.stringify({
									source: 'indicator',
									state: {
										initialGroup: 'mergeable',
										selectTopItem: labelType === 'item',
									},
								}),
							)} "Open Ready to Merge in Launchpad")`,
						);
						color = '#00FF00';
						break;
					}
					case 'blocked': {
						const action = groupByMap(items, i =>
							i.actionableCategory === 'failed-checks' ||
							i.actionableCategory === 'conflicts' ||
							i.actionableCategory === 'unassigned-reviewers'
								? i.actionableCategory
								: 'blocked',
						);

						const hasMultipleCategories = action.size > 1;

						let item: FocusItem | undefined;
						let actionMessage = '';
						let summaryMessage = '(';

						let actionGroupItems = action.get('unassigned-reviewers');
						if (actionGroupItems?.length) {
							actionMessage = `${actionGroupItems.length > 1 ? 'need' : 'needs'} reviewers`;
							summaryMessage += `${actionGroupItems.length} ${actionMessage}`;
							item ??= actionGroupItems[0];
						}

						actionGroupItems = action.get('failed-checks');
						if (actionGroupItems?.length) {
							actionMessage = `failed CI checks`;
							summaryMessage += `${hasMultipleCategories ? ', ' : ''}${
								actionGroupItems.length
							} ${actionMessage}`;
							item ??= actionGroupItems[0];
						}

						actionGroupItems = action.get('conflicts');
						if (actionGroupItems?.length) {
							actionMessage = `${actionGroupItems.length > 1 ? 'have' : 'has'} conflicts`;
							summaryMessage += `${hasMultipleCategories ? ', ' : ''}${
								actionGroupItems.length
							} ${actionMessage}`;
							item ??= actionGroupItems[0];
						}

						summaryMessage += ')';

						topIcon ??= 'error';
						tooltip.appendMarkdown(
							`<span style="color:#FF0000;">$(error)</span> [${
								labelType === 'item' && item != null && topItem == null
									? this.getTopItemLabel(item, items.length)
									: pluralize('pull request', items.length)
							} ${
								hasMultipleCategories ? 'are blocked' : actionMessage
							}](command:gitlens.showLaunchpad?${encodeURIComponent(
								JSON.stringify({
									source: 'indicator',
									state: { initialGroup: 'blocked', selectTopItem: labelType === 'item' },
								}),
							)} "Open Blocked in Launchpad")`,
						);
						if (hasMultipleCategories) {
							tooltip.appendMarkdown(`\\\n$(blank) ${summaryMessage}`);
						}

						color ??= '#FF0000';
						if (item != null) {
							let label = 'is blocked';
							if (item.actionableCategory === 'unassigned-reviewers') {
								label = 'needs reviewers';
							} else if (item.actionableCategory === 'failed-checks') {
								label = 'failed CI checks';
							} else if (item.actionableCategory === 'conflicts') {
								label = 'has conflicts';
							}
							topItem ??= { item: item, groupLabel: label };
						}
						break;
					}
					case 'follow-up': {
						topIcon ??= 'report';
						tooltip.appendMarkdown(
							`<span style="color:#3d90fc;">$(report)</span> [${
								labelType === 'item' && topItem == null && items.length
									? this.getTopItemLabel(items[0], items.length)
									: pluralize('pull request', items.length)
							} ${
								items.length > 1 ? 'require' : 'requires'
							} follow-up](command:gitlens.showLaunchpad?${encodeURIComponent(
								JSON.stringify({
									source: 'indicator',
									state: {
										initialGroup: 'follow-up',
										selectTopItem: labelType === 'item',
									},
								}),
							)} "Open Follow-Up in Launchpad")`,
						);
						color ??= '#FFA500';
						topItem ??= { item: items[0], groupLabel: 'requires follow-up' };
						break;
					}
					case 'needs-review': {
						topIcon ??= 'comment-draft';
						tooltip.appendMarkdown(
							`<span style="color:#3d90fc;">$(comment-draft)</span> [${
								labelType === 'item' && topItem == null && items.length
									? this.getTopItemLabel(items[0], items.length)
									: pluralize('pull request', items.length)
							} ${
								items.length > 1 ? 'need' : 'needs'
							} your review](command:gitlens.showLaunchpad?${encodeURIComponent(
								JSON.stringify({
									source: 'indicator',
									state: {
										initialGroup: 'needs-review',
										selectTopItem: labelType === 'item',
									},
								}),
							)} "Open Needs Your Review in Launchpad")`,
						);
						color ??= '#FFFF00';
						topItem ??= { item: items[0], groupLabel: 'needs your review' };
						break;
					}
				}
			}
		}

		const iconSegment = topIcon != null && iconType === 'group' ? `$(${topIcon})` : '$(rocket)';
		const labelSegment =
			labelType === 'item' && topItem != null
				? ` ${this.getTopItemLabel(topItem.item)} ${topItem.groupLabel}`
				: '';

		this._statusBarFocus.text = `${iconSegment}${labelSegment}`;
		this._statusBarFocus.tooltip = tooltip;
		this._statusBarFocus.color = useColors ? color : undefined;
	}

	private registerCommands(): Disposable[] {
		return [
			registerCommand('gitlens.launchpad.indicator.action', async (action: string) => {
				switch (action) {
					case 'hide': {
						const hide = { title: 'Hide Anyway' };
						const cancel = { title: 'Cancel', isCloseAffordance: true };
						const action = await window.showInformationMessage(
							'GitLens Launchpad helps you focus and keep your team unblocked.\n\nAre you sure you want hide the indicator?',
							{
								modal: true,
								detail: '\nYou can always access Launchpad using the "GitLens: Open Launchpad" command, and can re-enable the indicator with the "GitLens: Toggle Launchpad Indicator" command.',
							},
							hide,
							cancel,
						);
						if (action === hide) {
							void configuration.updateEffective('launchpad.indicator.enabled', false);
						}
						break;
					}
					case 'connectGitHub': {
						const github = await this.container.integrations?.get(HostingIntegrationId.GitHub);
						if (github == null) break;
						if (!(github.maybeConnected ?? (await github.isConnected()))) {
							void github.connect();
						}
						break;
					}
					default:
						break;
				}
			}),
		];
	}

	private getTopItemLabel(item: FocusItem, groupLength?: number) {
		return `${item.repository != null ? `${item.repository.owner.login}/${item.repository.name}` : ''}#${item.id}${
			groupLength != null && groupLength > 1
				? ` and ${pluralize('pull request', groupLength - 1, { infix: ' other ' })}`
				: ''
		}`;
	}

	private sendTelemetryFirstLoadEvent() {
		if (!this.container.telemetry.enabled) return;

		const hasLoaded = this.container.storage.get('launchpad:indicator:hasLoaded') ?? false;
		if (!hasLoaded) {
			void this.container.storage.store('launchpad:indicator:hasLoaded', true);
			this.container.telemetry.sendEvent('launchpad/indicator/firstLoad');
		}
	}
}
