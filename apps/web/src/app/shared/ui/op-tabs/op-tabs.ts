import {
    AfterViewInit,
    ChangeDetectionStrategy,
    Component,
    ElementRef,
    effect,
    input,
    OnDestroy,
    output,
    QueryList,
    signal,
    ViewChildren,
} from "@angular/core";
import type { TabView } from "../../../core/models/workflow.models";

@Component({
    selector: "op-tabs",
    standalone: true,
    changeDetection: ChangeDetectionStrategy.OnPush,
    templateUrl: "./op-tabs.html",
    styleUrl: "./op-tabs.scss",
})
export class OpTabsComponent implements AfterViewInit, OnDestroy {
    public readonly tabs = input<TabView[]>([]);
    public readonly active = input<string>("similar");
    public readonly ariaLabel = input("标签");
    public readonly showCount = input(true);
    public readonly indicator = signal({ left: 0, width: 0, visible: false });

    public readonly activeChange = output<string>();

    @ViewChildren("tabButton") private readonly tabButtons?: QueryList<ElementRef<HTMLButtonElement>>;

    private readonly subscriptions: { unsubscribe: () => void }[] = [];
    private readonly resizeObserver?: ResizeObserver;
    private viewReady = false;
    private pendingFrame?: number;

    public constructor(private readonly host: ElementRef<HTMLElement>) {
    effect(() => {
      this.active();
      this.tabs();
      this.queueIndicatorSync();
    });

    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.queueIndicatorSync());
    }
  }

    public ngAfterViewInit(): void {
    this.viewReady = true;
    const changes = this.tabButtons?.changes.subscribe(() => this.queueIndicatorSync());
    if (changes) {
      this.subscriptions.push(changes);
    }
    this.resizeObserver?.observe(this.host.nativeElement);
    this.queueIndicatorSync();
  }

    public ngOnDestroy(): void {
    if (this.pendingFrame !== undefined && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(this.pendingFrame);
    }
    this.resizeObserver?.disconnect();
    for (const subscription of this.subscriptions) {
      subscription.unsubscribe();
    }
  }

    public selectTab(kind: string): void {
    this.activeChange.emit(kind);
    this.queueIndicatorSync();
  }

    private queueIndicatorSync(): void {
    if (!this.viewReady) {
      return;
    }
    if (this.pendingFrame !== undefined && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(this.pendingFrame);
    }
    const run = () => {
      this.pendingFrame = undefined;
      this.syncIndicator();
    };
    if (typeof requestAnimationFrame === 'function') {
      this.pendingFrame = requestAnimationFrame(run);
    } else {
      window.setTimeout(run, 0);
    }
  }

    private syncIndicator(): void {
    const tabs = this.tabs();
    const buttons = this.tabButtons?.toArray() ?? [];
    const index = tabs.findIndex((tab) => tab.kind === this.active());
    const button = index >= 0 ? buttons[index]?.nativeElement : undefined;
    if (!button || button.offsetWidth <= 0) {
      this.indicator.set({ left: 0, width: 0, visible: false });
      return;
    }
    this.indicator.set({
      left: button.offsetLeft,
      width: button.offsetWidth,
      visible: true
    });
  }
}
