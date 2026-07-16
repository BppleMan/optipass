import { ChangeDetectionStrategy, Component, ElementRef, input, output, QueryList, ViewChildren } from "@angular/core";

export enum SegmentedControlIcon {
    Archive = "archive", Delete = "delete", Keep = "keep", Manual = "manual",
}

export enum SegmentedControlSize {
    Compact = "compact", Comfortable = "comfortable", Regular = "regular",
}

enum KeyboardDirection {
    Previous = "previous", Next = "next", First = "first", Last = "last",
}

interface KeyboardDirectionLookup {
    direction?: KeyboardDirection;
}

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
        "[attr.data-full-width]": "fullWidth()",
    },
})
export class SegmentedControlComponent {
    public readonly items = input.required<SegmentedControlItem[]>();
    public readonly value = input.required<string>();
    public readonly disabled = input(false);
    public readonly ariaLabel = input.required<string>();
    public readonly size = input(SegmentedControlSize.Compact, { transform: segmentedControlSize });
    public readonly fullWidth = input(false);
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
        const lookup = keyboardDirection(event.key);
        if (!lookup.direction) {
            return;
        }

        event.preventDefault();
        const enabledIndexes = this.items()
            .map((item, index) => item.disabled ? undefined : index)
            .filter((index): index is number => index !== undefined);
        if (enabledIndexes.length === 0) {
            return;
        }

        const nextIndex = nextEnabledIndex(enabledIndexes, currentIndex, lookup.direction);
        const nextItem = this.items()[nextIndex];
        this.select(nextItem);
        this.buttons.get(nextIndex)?.nativeElement.focus();
    }
}

function segmentedControlSize(value: unknown): SegmentedControlSize {
    if (value === SegmentedControlSize.Comfortable) return SegmentedControlSize.Comfortable;
    if (value === SegmentedControlSize.Regular) return SegmentedControlSize.Regular;
    return SegmentedControlSize.Compact;
}

function keyboardDirection(key: string): KeyboardDirectionLookup {
    switch (key) {
        case "ArrowLeft":
        case "ArrowUp":
            return { direction: KeyboardDirection.Previous };
        case "ArrowRight":
        case "ArrowDown":
            return { direction: KeyboardDirection.Next };
        case "Home":
            return { direction: KeyboardDirection.First };
        case "End":
            return { direction: KeyboardDirection.Last };
        default:
            return {};
    }
}

function nextEnabledIndex(enabledIndexes: number[], currentIndex: number, direction: KeyboardDirection): number {
    if (direction === KeyboardDirection.First) {
        return enabledIndexes[0];
    }
    if (direction === KeyboardDirection.Last) {
        return enabledIndexes[enabledIndexes.length - 1];
    }

    const currentEnabledIndex = enabledIndexes.findIndex((index) => index === currentIndex);
    const delta = direction === KeyboardDirection.Previous ? -1 : 1;
    const nextOffset = (currentEnabledIndex + delta + enabledIndexes.length) % enabledIndexes.length;
    return enabledIndexes[nextOffset];
}
