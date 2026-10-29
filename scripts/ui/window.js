/**
 * One window per class. The settings menus (through `menuLauncher`), the directory shortcuts, the other windows and the
 * module API all call the class's `open()`, which reuses the open window: a minimized one is restored, any other is
 * brought to the front. The class declares `static instance = null` and calls `releaseSingleton(this)` from `close()`, so
 * the next opening creates a fresh window.
 */
export function openSingleton(Window) {
  const app = Window.instance ??= new Window();
  if (!app.rendered) app.render({ force: true });
  else { if (app.minimized) void app.maximize(); app.bringToFront(); }
  return app;
}

export function releaseSingleton(app) {
  if (app.constructor.instance === app) app.constructor.instance = null;
}
