import type { TwitchPlayerConstructor, TwitchPlayerOptions } from "./twitchPlayerApi";
import { resetTwitchPlayerApiForTests } from "./twitchPlayerApi";

// Doble de `Twitch.Player` SOLO para tests (jsdom no carga el script oficial): crea un iframe
// de player.twitch.tv dentro del elemento, registra cada comando y permite emitir eventos.

export class FakeTwitchPlayer {
  static readonly READY = "ready";
  static instances: FakeTwitchPlayer[] = [];

  readonly frame: HTMLIFrameElement;
  readonly calls: string[] = [];
  private listeners = new Map<string, Array<() => void>>();
  private muted: boolean;
  private volume = 0.5;

  constructor(
    elementId: string,
    readonly options: TwitchPlayerOptions,
  ) {
    const el = document.getElementById(elementId);
    if (!el) throw new Error("contenedor inexistente");
    this.frame = document.createElement("iframe");
    const source = options.video
      ? `video=${options.video}`
      : `channel=${options.channel}`;
    this.frame.src = `https://player.twitch.tv/?${source}&parent=${options.parent[0]}`;
    el.appendChild(this.frame);
    this.muted = options.muted;
    FakeTwitchPlayer.instances.push(this);
  }

  play() {
    this.calls.push("play");
  }
  pause() {
    this.calls.push("pause");
  }
  setMuted(muted: boolean) {
    this.calls.push(`setMuted:${muted}`);
    this.muted = muted;
  }
  getMuted() {
    return this.muted;
  }
  setVolume(level: number) {
    this.calls.push(`setVolume:${level}`);
    this.volume = level;
  }
  getVolume() {
    return this.volume;
  }
  addEventListener(event: string, callback: () => void) {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), callback]);
  }

  /** Test: simula un evento del reproductor. */
  emit(event: string) {
    for (const cb of this.listeners.get(event) ?? []) cb();
  }
  /** Test: fija el volumen sin registrar un comando. */
  seedVolume(level: number) {
    this.volume = level;
  }
}

export function installFakeTwitch() {
  FakeTwitchPlayer.instances = [];
  resetTwitchPlayerApiForTests();
  window.Twitch = { Player: FakeTwitchPlayer as unknown as TwitchPlayerConstructor };
}

export function removeFakeTwitch() {
  delete window.Twitch;
  FakeTwitchPlayer.instances = [];
  resetTwitchPlayerApiForTests();
}
