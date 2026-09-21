"use strict";

import powerbi from "powerbi-visuals-api";
import IVisual = powerbi.extensibility.visual.IVisual;
import VisualConstructorOptions = powerbi.extensibility.visual.VisualConstructorOptions;
import VisualUpdateOptions = powerbi.extensibility.visual.VisualUpdateOptions;

import { API_JS, EMULATOR_B64, ZIP_B64 } from "./embedded";

const GAME_KEYS = [
  "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
  " ", "Control", "Shift", "Alt", "Tab", "Escape", "Enter",
];

// true = mostra o painel de diagnóstico; false = painel escondido (só aparece se houver "ERRO")
const DEBUG = false;

function decodeBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export class Visual implements IVisual {
  private root: HTMLDivElement;
  private diag: HTMLDivElement;
  private lines: string[] = [];
  private tickText = "";
  private logBuf: string[] = [];
  private logDropped = 0;

  constructor(options: VisualConstructorOptions) {
    this.root = document.createElement("div");
    this.root.id = "dosbox";
    this.root.style.cssText = "position:relative;width:100%;height:100%;background:#222;overflow:hidden;";
    options.element.appendChild(this.root);

    // Painel de diagnóstico (dentro do próprio visual, sempre visível)
    this.diag = document.createElement("div");
    this.diag.style.cssText =
      "position:absolute;left:0;bottom:0;z-index:1000;max-width:100%;font:10px monospace;pointer-events:none;" +
      "color:#fff;background:rgba(0,0,0,.75);padding:3px 5px;white-space:pre-wrap;" +
      (DEBUG ? "" : "display:none;");
    options.element.appendChild(this.diag);
    this.say("1. visual criado");
    if (DEBUG) this.hookConsole();

    window.addEventListener("error", (e) => this.say("ERRO: " + (e.message || String(e.error))));
    window.addEventListener("unhandledrejection", (e) => this.say("ERRO (promise): " + String(e.reason)));

    // Impede que setas/espaço rolem a página enquanto o jogo tem o foco
    document.addEventListener(
      "keydown",
      (e) => { if (GAME_KEYS.indexOf(e.key) !== -1) e.preventDefault(); },
      true
    );

    try {
      this.start();
    } catch (e) {
      this.say("ERRO no start: " + String(e));
    }
  }

  private say(msg: string) {
    if (!DEBUG && msg.indexOf("ERRO") !== -1) this.diag.style.display = "block";
    this.lines.push(msg);
    if (this.lines.length > 30) this.lines.shift();
    this.render();
  }

  private render() {
    this.diag.textContent = this.lines.join("\n") + (this.tickText ? "\n" + this.tickText : "");
  }

  // Guarda o que o emulador escreve no console e o despeja no painel no máximo a cada 500 ms
  // (renderizar a cada mensagem poderia travar o Power BI se houver muito log)
  private hookConsole() {
    const self = this;
    (["log", "warn", "error"] as const).forEach((k) => {
      const orig = (console as any)[k];
      (console as any)[k] = function (...args: any[]) {
        try {
          if (self.logBuf.length < 300) {
            self.logBuf.push("[" + k + "] " + args.map((a) => String(a)).join(" ").slice(0, 160));
          } else {
            self.logDropped++;
          }
        } catch (_) { /* ignora */ }
        return orig.apply(console, args);
      };
    });
    let n = 0;
    setInterval(() => {
      n++;
      let flushed = 0;
      while (self.logBuf.length && flushed < 12) { self.lines.push(self.logBuf.shift() as string); flushed++; }
      if (self.logDropped > 0) { self.lines.push("(" + self.logDropped + " mensagens de log descartadas)"); self.logDropped = 0; }
      while (self.lines.length > 30) self.lines.shift();
      self.tickText = "tick " + n + " (se parar de subir, a thread travou)";
      self.render();
    }, 500);
  }

  // Informações do ambiente do Power BI relevantes para o emulador
  private probe() {
    const w = window as any;
    this.say("   rAF:" + typeof w.requestAnimationFrame + " WebAssembly:" + typeof w.WebAssembly +
      " SAB:" + typeof w.SharedArrayBuffer + " isolado:" + w.crossOriginIsolated);
    this.say("   cpus:" + navigator.hardwareConcurrency + " memGB:" + (navigator as any).deviceMemory);
    const pm = (performance as any).memory;
    if (pm) this.say("   heap JS: " + Math.round(pm.usedJSHeapSize / 1048576) + " / " +
      Math.round(pm.jsHeapSizeLimit / 1048576) + " MB");
    // O emulador pode depender de IndexedDB (salvamentos). Se o sandbox o bloqueia, a inicialização não termina.
    try {
      let respondeu = false;
      const req = indexedDB.open("doom-probe");
      req.onsuccess = () => { respondeu = true; this.say("   IndexedDB: OK"); try { req.result.close(); indexedDB.deleteDatabase("doom-probe"); } catch (_) { /* ignora */ } };
      req.onerror = () => { respondeu = true; this.say("   IndexedDB: ERRO " + String(req.error)); };
      req.onblocked = () => { respondeu = true; this.say("   IndexedDB: bloqueado"); };
      setTimeout(() => { if (!respondeu) this.say("   IndexedDB: SEM RESPOSTA em 2 s"); }, 2000);
    } catch (e) {
      this.say("   IndexedDB: exceção " + String(e));
    }
    if (w.requestAnimationFrame) {
      let frames = 0;
      const t0 = performance.now();
      const f = () => {
        frames++;
        if (performance.now() - t0 < 1000) w.requestAnimationFrame(f);
        else this.say("   rAF: " + frames + " quadros em 1 s");
      };
      w.requestAnimationFrame(f);
    }
  }

  private start() {
    // Testa se o sandbox permite avaliar código dinâmico
    try { new Function("return 1")(); this.say("2. new Function permitido"); }
    catch (e) { this.say("2. new Function BLOQUEADO: " + String(e)); throw e; }

    // O Power BI já tem um jQuery real (v3.x) no iframe. A API do js-dos traz um mini-jQuery
    // que só se instala se não houver jQuery, e o jQuery real descarta o texto de
    // '<div class="x">Click to start' (botão vazio). Solução: executar a API num escopo
    // próprio, onde "jQuery" e "$" são variáveis locais e o mini-jQuery se instala num
    // objeto "sandbox", sem tocar no jQuery global do Power BI.
    const w = window as any;
    this.say("   jQuery global do Power BI: " + (typeof w.jQuery) + (w.jQuery && w.jQuery.fn ? " v" + w.jQuery.fn.jquery : ""));

    const trocas: Array<[string, string]> = [
      // Se o documento já terminou de carregar (é o caso no Power BI), a API sairia
      // cedo demais e nunca instalaria o mini-jQuery. Esta troca evita esse "return".
      ['if(i.readyState==="complete")return f.ready();', 'if(i.readyState==="complete")f.ready();'],
      ['typeof window.jQuery=="undefined"', 'typeof sandbox.jQuery=="undefined"'],
      [
        'window.jQuery=f;window.jQuery.fn=x.prototype;window.$=window.jQuery;window.now=B',
        'sandbox.jQuery=f;sandbox.jQuery.fn=x.prototype;sandbox.$=sandbox.jQuery;jQuery=sandbox.jQuery;$=sandbox.$;window.now=B',
      ],
    ];
    let api = API_JS;
    for (const [de, para] of trocas) {
      if (api.indexOf(de) === -1) throw new Error("Trecho não encontrado na API: " + de);
      api = api.replace(de, para);
    }

    // "this" = window (a API faz "this.Dosbox = ..."); jQuery/$ locais e isolados
    new Function("sandbox", "jQuery", "$", api).call(window, {}, undefined, undefined);
    const Dosbox = w.Dosbox;
    if (!Dosbox) throw new Error("js-dos API não definiu Dosbox");
    this.say("3. API js-dos carregada");
    if (DEBUG) this.probe();

    // No Power BI o run() do emulador fica esperando uma "dependência" que nunca é resolvida
    // (log: "Preparing... (0/1)" sem "Running..."). Antes de iniciar o DOSBox, destravamos
    // o run() e esperamos ele executar (calledRun), como no experimento manual que funcionou.
    const origMain = Dosbox.prototype._dosbox_main;
    const selfMain = this;
    Dosbox.prototype._dosbox_main = function (d: any, exe: string) {
      const m = d.module;
      if (!m.calledRun) {
        selfMain.say("   run() pendente: forçando removeRunDependency()");
        try { m.removeRunDependency(); } catch (e) { selfMain.say("ERRO no removeRunDependency: " + String(e)); }
      }
      const t0 = performance.now();
      const esperar = () => {
        if (m.calledRun) {
          selfMain.say("   run() executado; iniciando " + exe);
          origMain.call(d, d, exe);
        } else if (performance.now() - t0 > 5000) {
          selfMain.say("ERRO: run() não executou em 5 s");
        } else {
          setTimeout(esperar, 50);
        }
      };
      esperar();
    };

    // Troca o download por rede pelos dados embutidos
    // Precisa ser "function" (não arrow): a API usa "new Dosbox.Xhr(...)"
    const self = this;
    Dosbox.Xhr = function (url: string, opts: any) {
      const nome = String(url).split("/").pop();
      self.say("   pedido: " + nome);
      setTimeout(() => {
        try {
          let data: any;
          if (nome === "js-dos-v3.js") data = atob(EMULATOR_B64.join(""));
          else if (nome === "Doom2.zip") data = decodeBytes(ZIP_B64.join(""));
          else { self.say("ERRO: arquivo não embutido: " + url); return; }
          if (opts.progress) opts.progress(1, 1);
          if (opts.success) opts.success(data);
          self.say("   entregue: " + nome);
        } catch (e) {
          self.say("ERRO ao entregar " + nome + ": " + String(e));
        }
      }, 0);
    };

    new Dosbox({
      id: "dosbox",
      onload: (d: any) => {
        this.say("4. emulador iniciado (eval ok)");
        setTimeout(() => this.say("   run() do emulador executado? calledRun=" + d.module.calledRun), 3000);
        d.run("Doom2.zip", "./DOOM2.EXE");
      },
      onrun: () => this.say("5. DOOM2.EXE em execução"),
    });
    this.say("3b. interface criada");

    // Verifica se o CSS injetado pela API foi aplicado; se não, aplica estilos inline
    setTimeout(() => this.checkStyles(), 500);
  }

  private checkStyles() {
    const overlay = this.root.querySelector(".dosbox-overlay") as HTMLElement | null;
    const box = this.root.querySelector(".dosbox-container") as HTMLElement | null;
    const start = this.root.querySelector(".dosbox-start") as HTMLElement | null;
    const loader = this.root.querySelector(".dosbox-loader") as HTMLElement | null;
    if (!overlay || !box) { this.say("6. interface NÃO encontrada no DOM"); return; }

    this.say("   botão start: " + (start ? start.outerHTML : "NÃO EXISTE"));
    const pos = getComputedStyle(overlay).position;
    this.say("6. overlay position=" + pos + " | container=" +
      Math.round(box.getBoundingClientRect().width) + "x" + Math.round(box.getBoundingClientRect().height));

    if (pos !== "absolute") {
      this.say("   CSS da API não aplicado (CSP?). Aplicando estilos inline.");
      box.style.position = "relative";
      const fill = "position:absolute;left:0;right:0;top:0;bottom:0;background:#333;";
      if (overlay) overlay.style.cssText = fill;
      if (loader) loader.style.cssText = fill + "display:none;color:#f80;text-align:center;padding-top:20%;font-size:1.5em;";
      if (start) start.style.cssText = "position:absolute;left:0;right:0;top:45%;text-align:center;color:#f80;font-size:1.5em;text-decoration:underline;cursor:pointer;";
      overlay.querySelectorAll("a, .dosbox-powered").forEach((el) => ((el as HTMLElement).style.color = "#9c9c9c"));
    }
  }

  public update(options: VisualUpdateOptions) {
    const w = options.viewport.width;
    const h = options.viewport.height;
    this.root.style.width = w + "px";
    this.root.style.height = h + "px";
    const box = this.root.querySelector(".dosbox-container") as HTMLElement | null;
    if (box) { box.style.width = w + "px"; box.style.height = h + "px"; }
    const canvas = this.root.querySelector("canvas") as HTMLElement | null;
    if (canvas) {
      canvas.style.width = "100%";
      canvas.style.height = "100%";
      canvas.style.imageRendering = "pixelated";
    }
  }
}
