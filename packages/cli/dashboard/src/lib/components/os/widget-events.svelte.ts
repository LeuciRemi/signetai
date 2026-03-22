// Cross-widget event bus.
// When a widget calls signet.emit(), the event is broadcast to all other widgets.

let lastEvent = $state<{ serverId: string; eventType: string; data: unknown; _seq: number } | null>(null);
let seq = 0;

export function broadcastWidgetEvent(serverId: string, eventType: string, data: unknown): void {
	lastEvent = { serverId, eventType, data, _seq: ++seq };
}

export function getLastEvent() {
	return lastEvent;
}
