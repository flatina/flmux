import { addDisposableListener } from "dockview-core/dist/esm/events";
import { DefaultTab } from "dockview-core/dist/esm/dockview/components/tab/defaultTab";

export class FlmuxTabRenderer extends DefaultTab {
  override init(parameters: any): void {
    super.init(parameters);
    this.setTabTooltip(parameters.title ?? "");

    this.addDisposables(
      parameters.api.onDidTitleChange((event: { title: string }) => {
        this.setTabTooltip(event.title ?? "");
      }),
      addDisposableListener(this.element, "pointerdown", (event: PointerEvent) => {
        if (event.button !== 1) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
      }),
      addDisposableListener(this.element, "auxclick", (event: MouseEvent) => {
        if (event.button !== 1) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        parameters.api.close();
      })
    );
  }

  protected setTabTooltip(value: string): void {
    this.element.title = value;
  }
}
