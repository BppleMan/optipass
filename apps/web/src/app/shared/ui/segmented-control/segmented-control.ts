import { ChangeDetectionStrategy, Component, ElementRef, input, output, QueryList, ViewChildren } from "@angular/core";

export type SegmentedControlIcon = "archive" | "delete" | "keep" | "manual";

export interface SegmentedControlItem {
    value: string;
    label: string;
    icon: SegmentedControlIcon;
    activeColor?: string;
    activeBackground?: string;
    disabled?: boolean;
}

@Component({
    selector: "op-segmented-control",
    standalone: true,
    changeDetection: ChangeDetectionStrategy.OnPush,
    templateUrl: "./segmented-control.html",
    styleUrl: "./segmented-control.scss",
    host: {
        "[attr.data-size]": "size()",
    },
})
export class SegmentedControlComponent {
    public readonly items = input.required<SegmentedControlItem[]>();
    public readonly value = input.required<string>();
    public readonly disabled = input(false);
    public readonly ariaLabel = input.required<string>();
    public readonly size = input<"compact" | "comfortable" | "regular">("compact");
    public readonly valueChange = output<string>();

    @ViewChildren("segmentButton") private readonly buttons!: QueryList<ElementRef<HTMLButtonElement>>;

    public isSelected(item: SegmentedControlItem): boolean {
        return item.value === this.value();
    }

    public selectedIndex(): number {
        return Math.max(0, this.items().findIndex((item) => this.isSelected(item)));
    }

    public selectedBackground(): string {
        return this.items().find((item) => this.isSelected(item))?.activeBackground ?? "rgba(176, 190, 197, 0.14)";
    }

    public select(item: SegmentedControlItem): void {
        if (this.disabled() || item.disabled || this.isSelected(item)) {
            return;
        }
        this.valueChange.emit(item.value);
    }

    public moveSelection(event: KeyboardEvent, currentIndex: number): void {
        const direction = keyboardDirection(event.key);
        if (direction === undefined) {
            return;
        }

        event.preventDefault();
        const enabledIndexes = this.items()
            .map((item, index) => item.disabled ? undefined : index)
            .filter((index): index is number => index !== undefined);
        if (enabledIndexes.length === 0) {
            return;
        }

        const nextIndex = nextEnabledIndex(enabledIndexes, currentIndex, direction);
        const nextItem = this.items()[nextIndex];
        this.select(nextItem);
        this.buttons.get(nextIndex)?.nativeElement.focus();
    }
}

function keyboardDirection(key: string): "first" | "last" | -1 | 1 | undefined {
    switch (key) {
        case "ArrowLeft":
        case "ArrowUp":
            return -1;
        case "ArrowRight":
        case "ArrowDown":
            return 1;
        case "Home":
            return "first";
        case "End":
            return "last";
        default:
            return undefined;
    }
}

function nextEnabledIndex(enabledIndexes: number[], currentIndex: number, direction: "first" | "last" | -1 | 1): number {
    if (direction === "first") {
        return enabledIndexes[0];
    }
    if (direction === "last") {
        return enabledIndexes[enabledIndexes.length - 1];
    }

    const currentEnabledIndex = enabledIndexes.findIndex((index) => index === currentIndex);
    const nextOffset = (currentEnabledIndex + direction + enabledIndexes.length) % enabledIndexes.length;
    return enabledIndexes[nextOffset];
}
