import type { Catalog } from "./en.js"

export default {
  "Reset page pinch zoom before capturing a region":
    "Сбросьте масштаб страницы, изменённый жестом, перед захватом области",
  "Capture region": "Снимок области",
  "Select a region": "Выберите область",
  "Drag on the page or enter CSS pixels. Minimum: 8 × 8.":
    "Перетащите на странице или введите CSS-пиксели. Минимум: 8 × 8.",
  X: "X",
  Y: "Y",
  Width: "Ширина",
  Height: "Высота",
  "Chrome temporarily captures the full viewport. Only the crop leaves the worker.":
    "Chrome временно захватывает всю видимую область. Из worker выходит только обрезанное изображение.",
  "Preview region": "Предпросмотр области",
  "Region preview": "Предпросмотр области",
  "Only this crop is attached. Text, selected elements, history, and approved page reads can include other content.":
    "Прикрепляется только этот фрагмент. Текст, выбранные элементы, история и разрешённые чтения страницы могут включать другое содержимое.",
  Retake: "Снять заново",
  "Finish or cancel region capture before sending":
    "Завершите или отмените снимок области перед отправкой",
  "Select a region at least 8 CSS pixels wide and high":
    "Выберите область шириной и высотой не менее 8 CSS-пикселей",
  "Could not confirm region cleanup. Reload the page before sending.":
    "Не удалось подтвердить удаление выделения. Перезагрузите страницу перед отправкой.",
  "The page changed. Select a new region.": "Страница изменилась. Выберите новую область.",
  "Region capture is unavailable on this page": "Снимок области недоступен на этой странице",
  "Could not preview the region. Select again or retry.":
    "Не удалось показать область. Выберите заново или повторите попытку.",
  "Image {number}": "Изображение {number}",
  "Use as target": "Использовать как цель",
  "Use as reference": "Использовать как образец",
  "Target: {target}": "Цель: {target}",
  "Reference: {reference}": "Образец: {reference}",
  "Not selected": "Не выбрано",
  "Clear pair": "Очистить пару",
  "Select a distinct target and reference": "Выберите разные цель и образец",
  "Describe the task for the target and reference": "Опишите задачу для цели и образца",
  "Question from Pi": "Вопрос от Pi",
  "Other answer": "Другой ответ",
  Answer: "Ответить",
  "This answer does not approve browser or remote actions.":
    "Этот ответ не разрешает действия браузера или удалённые действия.",
  "Answer or stop the pending question first":
    "Сначала ответьте на ожидающий вопрос или остановите его",
  "Choose an option or enter an answer of at most 2,048 characters":
    "Выберите вариант или введите ответ длиной до 2048 символов",
  "The question is no longer active": "Вопрос больше не активен",
  "Draw on page": "Рисовать на странице",
  "Cancel page drawing": "Отменить рисование на странице",
  "Pen color": "Цвет пера",
  "Drawing tool": "Инструмент рисования",
  Freehand: "От руки",
  Arrow: "Стрелка",
  Rectangle: "Прямоугольник",
  "Page drawing controls": "Элементы управления рисованием на странице",
  Red: "Красный",
  Yellow: "Жёлтый",
  Green: "Зелёный",
  Blue: "Синий",
  White: "Белый",
  Black: "Чёрный",
  "Page content can move beneath your marks. Send captures only the visible area.":
    "Содержимое страницы может перемещаться под отметками. При отправке захватывается только видимая область.",
  "Wait for the current operation to finish before drawing":
    "Дождитесь завершения текущей операции, прежде чем рисовать",
  "Open an HTTP or HTTPS page before drawing":
    "Откройте страницу HTTP или HTTPS, прежде чем рисовать",
  "Site access is required to draw on this page":
    "Для рисования на этой странице требуется доступ к сайту",
  "The page changed before drawing could start. Start drawing again.":
    "Страница изменилась до начала рисования. Начните рисование заново.",
  "Page drawing could not start. Reload the page and try again.":
    "Не удалось начать рисование на странице. Перезагрузите страницу и повторите попытку.",
  "Page drawing stopped because the page or its protection changed. Start drawing again.":
    "Рисование остановлено, поскольку страница или её защита изменилась. Начните рисование заново.",
  "Could not capture page drawing. Your marks were kept when safe. Try again.":
    "Не удалось захватить рисунок на странице. Отметки сохранены, если это было безопасно. Повторите попытку.",
  "Could not confirm drawing cleanup. Reload the page before sending.":
    "Не удалось подтвердить удаление поверхности рисования. Перезагрузите страницу перед отправкой.",
  "Add a mark before sending page drawing": "Добавьте отметку перед отправкой рисунка на странице",
  "Page drawing limit reached. Undo or clear some marks.":
    "Достигнут предел рисования на странице. Отмените или удалите часть отметок.",
  "Paste a PNG, JPEG, WebP, or GIF image": "Вставьте изображение PNG, JPEG, WebP или GIF",
  "The pasted image is empty": "Вставленное изображение пустое",
  "Pasted images must use 3 MB or less in total":
    "Общий размер вставленных изображений не должен превышать 3 MB",
  "Attach a PNG, JPEG, WebP, or GIF image": "Прикрепите изображение PNG, JPEG, WebP или GIF",
  "The generated image is empty": "Созданное изображение пустое",
  "Composer images must use 3 MB or less in total":
    "Общий размер изображений в поле ввода не должен превышать 3 MB",
  "Saved message exceeds the composer image limit":
    "Сохранённое сообщение превышает предел изображений поля ввода",
  "Saved message contains an unsupported image":
    "Сохранённое сообщение содержит неподдерживаемое изображение",
  "Saved message images exceed the 3 MB composer limit":
    "Изображения сохранённого сообщения превышают предел поля ввода 3 MB",
  "16 to 4096 characters. Blank keeps an existing token at the same endpoint.":
    "От 16 до 4096 символов. Пустое поле сохраняет существующий токен для той же конечной точки.",
  "A Chrome-native AI assistant for the page you are viewing.":
    "ИИ-помощник в Chrome для просматриваемой страницы.",
  "A skill with this name is already installed": "Навык с таким именем уже установлен",
  "A skill with this name is already installed; use explicit replacement":
    "Навык с таким именем уже установлен; явно выберите замену",
  "A task started before the prompt could be sent. Send it again.":
    "Задача запустилась до отправки запроса. Отправьте его ещё раз.",
  "AGENTS-style instructions": "Инструкции в формате AGENTS",
  "API key": "Ключ API",
  Account: "Аккаунт",
  "Account and access": "Аккаунт и доступ",
  "Account and settings": "Аккаунт и настройки",
  "Account login is not configured for {provider} in Chrome":
    "Вход через аккаунт для {provider} в Chrome не настроен",
  "Actions that always require confirmation": "Действия, всегда требующие подтверждения",
  "Activate a page element.": "Активировать элемент страницы.",
  "Active path": "Активный путь",
  Activity: "Действия",
  "Add a credential and choose a model before saving this selection.":
    "Добавьте учётные данные и выберите модель, прежде чем сохранять этот выбор.",
  "Add an instruction while Pi is working": "Добавьте инструкцию, пока Pi работает",
  "Add credential": "Добавить учётные данные",
  "Add instruction": "Добавить инструкцию",
  "Add task guidance. These instructions cannot grant browser permissions.":
    "Добавьте указания для задачи. Эти инструкции не могут предоставлять разрешения браузера.",
  "All browser tools, including new tools added by updates, are enabled by default. Uncheck tools to disable them. Changes apply to the next run; confirmations and Chrome permissions still apply.":
    "Все инструменты браузера, включая добавленные при обновлениях, включены по умолчанию. Снимите флажки, чтобы отключить инструменты. Изменения действуют со следующего запуска; подтверждения и разрешения Chrome по-прежнему требуются.",
  "All-sites access is required to capture screenshots after tab changes":
    "Для снимков экрана после смены вкладки нужен доступ ко всем сайтам",
  "Allow current site": "Разрешить текущий сайт",
  "Allow microphone access": "Разрешить доступ к микрофону",
  "Allow microphone access in the opened tab, then select the microphone again.":
    "Разрешите доступ к микрофону в открывшейся вкладке, затем снова выберите микрофон.",
  "Allow screenshots of visible HTTP(S) tabs? Chrome grants access to all sites, but Pi Browser Agent captures only the current visible viewport and separately limits ordinary access to exact origins approved through explicit actions. Screenshots are sent to the selected model provider and saved in this session.":
    "Разрешить снимки экрана видимых вкладок HTTP(S)? Chrome предоставляет доступ ко всем сайтам, но Pi Browser Agent снимает только текущую видимую область и отдельно ограничивает обычный доступ точными источниками, одобренными явными действиями. Снимки отправляются выбранному поставщику модели и сохраняются в этом сеансе.",
  "An annotation can contain at most {count} strokes": {
    one: "Аннотация может содержать не более {count} штриха",
    few: "Аннотация может содержать не более {count} штрихов",
    many: "Аннотация может содержать не более {count} штрихов",
    other: "Аннотация может содержать не более {count} штриха",
  },
  "Annotate screenshot": "Добавить пометки на снимок экрана",
  Appearance: "Внешний вид",
  "Ask a question or describe a task": "Задайте вопрос или опишите задачу",
  "Ask a question, find a detail, or explore the page you're on.":
    "Задайте вопрос, найдите нужную деталь или изучите текущую страницу.",
  "Ask about the current page": "Спросить о текущей странице",
  Assistant: "Помощник",
  Attach: "Прикрепить",
  "Attach up to {count} images at a time": {
    one: "Прикрепляйте не более {count} изображения за раз",
    few: "Прикрепляйте не более {count} изображений за раз",
    many: "Прикрепляйте не более {count} изображений за раз",
    other: "Прикрепляйте не более {count} изображения за раз",
  },
  "Attach up to {count} selected elements": {
    one: "Прикрепляйте не более {count} выбранного элемента",
    few: "Прикрепляйте не более {count} выбранных элементов",
    many: "Прикрепляйте не более {count} выбранных элементов",
    other: "Прикрепляйте не более {count} выбранного элемента",
  },
  Authentication: "Аутентификация",
  "Authentication is unavailable. Try again.": "Аутентификация недоступна. Повторите попытку.",
  "Available tools": "Доступные инструменты",
  Back: "Назад",
  "Back to conversation": "Вернуться к беседе",
  Balanced: "Сбалансированный",
  "Bearer token (optional)": "Токен Bearer (необязательно)",
  "Bookmark access is required for this read": "Для этого чтения нужен доступ к закладкам",
  "Bookmark reads require approval. Your confirmation mode can reuse approval for identical arguments. Results are untrusted.":
    "Чтение закладок требует одобрения. Выбранный режим подтверждения может повторно использовать одобрение для одинаковых аргументов. Результаты не являются доверенными.",
  Bookmarks: "Закладки",
  "Branch changed. Your newer draft and attachments were retained.":
    "Ветка изменилась. Более новый черновик и вложения сохранены.",
  "Browser action confirmations": "Подтверждения действий браузера",
  "Browser active tab": "Активная вкладка браузера",
  "Browser assistant": "Помощник браузера",
  "Call this page-provided WebMCP tool? It may have side effects, even when called again with identical arguments.":
    "Вызвать этот инструмент WebMCP, предоставленный страницей? Он может иметь побочные эффекты даже при повторном вызове с одинаковыми аргументами.",
  "Call this remote MCP tool? Arguments go to this server; results go to the selected model and saved session. This call may have side effects. Every call requires confirmation.":
    "Вызвать этот удалённый инструмент MCP? Аргументы передаются этому серверу; результаты — выбранной модели и в сохранённый сеанс. Вызов может иметь побочные эффекты. Каждый вызов требует подтверждения.",
  "Calling a remote tool": "Вызов удалённого инструмента",
  Cancel: "Отмена",
  "Cancel element selection": "Отменить выбор элемента",
  "Cancel element selection ({shortcut})": "Отменить выбор элемента ({shortcut})",
  "Canvas is not visible": "Холст не виден",
  "Capture the visible viewport.": "Сделать снимок видимой области.",
  "Capture viewport": "Снимок видимой области",
  "Captured the visible page": "Снимок видимой страницы сделан",
  "Capturing the visible page": "Создание снимка видимой страницы",
  "Change a checkbox or radio state.": "Изменить состояние флажка или переключателя.",
  "Changed WebMCP arguments, bookmark queries, or destinations ask again. Chrome permissions and safety checks remain separate.":
    "При изменении аргументов WebMCP, запросов к закладкам или адресов назначения подтверждение запрашивается снова. Разрешения Chrome и проверки безопасности остаются отдельными.",
  "Changing checked state can submit a form or run page actions":
    "Изменение состояния флажка может отправить форму или выполнить действия страницы",
  "Changing this option can submit a form or run page actions":
    "Изменение этого параметра может отправить форму или выполнить действия страницы",
  "Checked the current tab": "Текущая вкладка проверена",
  "Checking credential status…": "Проверка состояния учётных данных…",
  "Checking current page…": "Проверка текущей страницы…",
  "Checking the current tab": "Проверка текущей вкладки",
  "Choose a native select option.": "Выбрать вариант в стандартном списке выбора.",
  "Choose a saved session": "Выберите сохранённый сеанс",
  "Choose a supported level": "Выберите поддерживаемый уровень",
  "Choose a supported level. Higher levels may use more tokens. Unrelated saves keep your saved preference.":
    "Выберите поддерживаемый уровень. Более высокие уровни могут расходовать больше токенов. Сохранение других настроек не меняет сохранённое предпочтение.",
  "Choose a thinking level supported by this model.":
    "Выберите уровень размышления, поддерживаемый этой моделью.",
  "Choose a valid confirmation mode": "Выберите допустимый режим подтверждения",
  "Choose a valid language": "Выберите допустимый язык",
  "Choose a valid thinking level": "Выберите допустимый уровень размышления",
  "Choose how long to remember an approval for the same action and target.":
    "Выберите, как долго помнить одобрение для того же действия и цели.",
  "Choose the font and text size used throughout the interface. Preview changes before saving.":
    "Выберите шрифт и размер текста для всего интерфейса. Просмотрите изменения перед сохранением.",
  "Choose the provider and model for this session and new conversations.":
    "Выберите поставщика и модель для этого сеанса и новых бесед.",
  "Chrome blocked microphone access. Open Chrome microphone settings, remove Pi Browser Agent from Not allowed, then return here and try again.":
    "Chrome заблокировал доступ к микрофону. Откройте настройки микрофона Chrome, удалите Pi Browser Agent из списка запрещённых, затем вернитесь сюда и повторите попытку.",
  "Chrome could not export the annotated screenshot":
    "Chrome не удалось экспортировать снимок экрана с пометками",
  "Chrome could not find a microphone. Connect or enable one, then try again.":
    "Chrome не удалось найти микрофон. Подключите или включите его и повторите попытку.",
  "Chrome did not export a PNG annotation": "Chrome не экспортировал пометки в формате PNG",
  Clear: "Очистить",
  "Clear all conversation data": "Удалить все данные бесед",
  "Clear headings": "Понятные заголовки",
  "Clear remembered approvals": "Очистить запомненные одобрения",
  "Clear the unsent draft before changing branches":
    "Очистите неотправленный черновик перед сменой ветки",
  "Clearing takes effect immediately. Cancel does not restore approvals.":
    "Очистка действует немедленно. Отмена не восстанавливает одобрения.",
  "Click Select page element to allow this site and start selection":
    "Нажмите «Выбрать элемент страницы», чтобы разрешить этот сайт и начать выбор",
  "Click element": "Нажать на элемент",
  "Close tab": "Закрыть вкладку",
  "Command list closed.": "Список команд закрыт.",
  "Command list open. {count} commands available.": {
    one: "Список команд открыт. Доступна {count} команда.",
    few: "Список команд открыт. Доступны {count} команды.",
    many: "Список команд открыт. Доступно {count} команд.",
    other: "Список команд открыт. Доступно {count} команды.",
  },
  Commands: "Команды",
  "Commands cannot be queued. Use Send when the conversation is idle.":
    "Команды нельзя ставить в очередь. Используйте «Отправить», когда в беседе нет активных операций.",
  "Composer image limits changed while attachments were loading":
    "Во время загрузки вложений изменились ограничения изображений в поле ввода",
  "Configure provider": "Настроить поставщика",
  "Configure provider to load models": "Настройте поставщика для загрузки моделей",
  "Configure the selected provider and choose a model":
    "Настройте выбранного поставщика и выберите модель",
  "Configure up to 8 public HTTPS Streamable HTTP servers. Select New server to add another. A run supports up to 32 tools across all enabled servers.":
    "Настройте до 8 общедоступных серверов HTTPS Streamable HTTP. Выберите «Новый сервер», чтобы добавить ещё один. Один запуск поддерживает до 32 инструментов суммарно на всех включённых серверах.",
  "Configure {provider} before sending a prompt": "Настройте {provider} перед отправкой запроса",
  Confirm: "Подтвердить",
  "Confirm browser action": "Подтвердить действие браузера",
  "Confirm settings change": "Подтвердить изменение настроек",
  "Confirmation mode": "Режим подтверждения",
  "Connect browser-compatible remote tools.":
    "Подключите удалённые инструменты, совместимые с браузером.",
  Continue: "Продолжить",
  Convenient: "Удобный",
  Conversation: "Беседа",
  "Conversation branches": "Ветки беседы",
  "Conversation name": "Название беседы",
  "Conversation preview": "Предпросмотр беседы",
  "Conversation tree": "Дерево беседы",
  Conversations: "Беседы",
  Copied: "Скопировано",
  "Copy all": "Копировать всё",
  "Copy code": "Копировать код",
  "Copy failed": "Не удалось скопировать",
  "Copying…": "Копирование…",
  "Could not attach the selected element. Try another element.":
    "Не удалось прикрепить выбранный элемент. Попробуйте другой элемент.",
  "Could not capture the visible page": "Не удалось сделать снимок видимой страницы",
  "Could not check the current tab": "Не удалось проверить текущую вкладку",
  "Could not enter text": "Не удалось ввести текст",
  "Could not find page controls": "Не удалось найти элементы управления страницы",
  "Could not open the page": "Не удалось открыть страницу",
  "Could not read recent bookmarks": "Не удалось прочитать недавние закладки",
  "Could not read the page": "Не удалось прочитать страницу",
  "Could not read the selection": "Не удалось прочитать выделение",
  "Could not search bookmarks": "Не удалось выполнить поиск в закладках",
  "Could not select the page control": "Не удалось выбрать элемент управления страницы",
  "Could not use the page feature": "Не удалось использовать функцию страницы",
  Credential: "Учётные данные",
  "Credential changes save separately. Saved credentials have not been tested with a model request.":
    "Изменения учётных данных сохраняются отдельно. Сохранённые учётные данные не проверены запросом к модели.",
  "Credential status unavailable. Try again.":
    "Состояние учётных данных недоступно. Повторите попытку.",
  "Current page: {page} — available with site access":
    "Текущая страница: {page} — доступна при разрешении доступа к сайту",
  "Current page: {page} — cannot read or operate":
    "Текущая страница: {page} — чтение и действия недоступны",
  "Current page: {page} — not used": "Текущая страница: {page} — не используется",
  "Current position": "Текущая позиция",
  "Delete conversation": "Удалить беседу",
  "Delete every saved conversation and image?": "Удалить все сохранённые беседы и изображения?",
  "Delete selected skill": "Удалить выбранный навык",
  "Delete selected skill?": "Удалить выбранный навык?",
  "Delete skill": "Удалить навык",
  "Delete this conversation and its stored images?":
    "Удалить эту беседу и её сохранённые изображения?",
  "Dependency warnings use heuristics and cannot detect every script or supporting-file requirement. Review the skill before enabling it.":
    "Предупреждения о зависимостях используют эвристики и не могут выявить все требуемые скрипты или вспомогательные файлы. Изучите навык перед включением.",
  Disable: "Отключить",
  Disabled: "Отключено",
  "Discard MCP changes and disable?": "Отбросить изменения MCP и отключить?",
  "Discard MCP changes?": "Отбросить изменения MCP?",
  "Discard and disable": "Отбросить и отключить",
  "Discard changes": "Отбросить изменения",
  "Discard drafts and save": "Отбросить черновики и сохранить",
  "Discard unsaved changes to the new server?": "Отбросить несохранённые изменения нового сервера?",
  "Discard unsaved changes to “{name}” and disable the saved server?":
    "Отбросить несохранённые изменения «{name}» и отключить сохранённый сервер?",
  "Discard unsaved changes to “{name}”?": "Отбросить несохранённые изменения «{name}»?",
  "Discard unsaved changes?": "Отбросить несохранённые изменения?",
  "Discover or call tools provided by the current page.":
    "Найти или вызвать инструменты, предоставленные текущей страницей.",
  "Draw over the screenshot, then attach the marked image to your next message.":
    "Нарисуйте пометки на снимке экрана, затем прикрепите изображение к следующему сообщению.",
  "Duplicate skill ID": "Повторяющийся ID навыка",
  "Each remote tool call requires confirmation in every mode and can have side effects. Tool metadata and results can go to your selected model and saved session.":
    "Каждый вызов удалённого инструмента требует подтверждения в любом режиме и может иметь побочные эффекты. Метаданные инструмента и результаты могут передаваться выбранной модели и в сохранённый сеанс.",
  "Edit {name}": "Изменить {name}",
  "Element selection is unavailable while another action is in progress or the attachment limit is reached":
    "Выбор элемента недоступен, пока выполняется другое действие или достигнут предел вложений",
  "Element selection lost its protection. Select again, or reload the page.":
    "Защита выбора элемента потеряна. Выберите снова или перезагрузите страницу.",
  "Enable selected skill": "Включить выбранный навык",
  Enabled: "Включено",
  "Enabled for new runs, not a live connection. Test again only to check the saved endpoint.":
    "Включено для новых запусков; это не активное подключение. Повторяйте тест только для проверки сохранённой конечной точки.",
  "Enabled for new runs. Tool metadata and results can go to the selected model.":
    "Включено для новых запусков. Метаданные инструмента и результаты могут передаваться выбранной модели.",
  "Enabled for new runs; each call requires confirmation":
    "Включено для новых запусков; каждый вызов требует подтверждения",
  "Enabled skill catalog exceeds the 16384-byte limit":
    "Каталог включённых навыков превышает предел 16384 байта",
  "Enter a public HTTPS MCP endpoint": "Введите общедоступную конечную точку HTTPS MCP",
  "Enter an MCP bearer token of 16 to 4096 characters without spaces":
    "Введите токен Bearer MCP длиной от 16 до 4096 символов без пробелов",
  "Enter an MCP server name of at most 80 characters":
    "Введите имя сервера MCP длиной не более 80 символов",
  "Enter text in an editable field.": "Ввести текст в редактируемое поле.",
  "Enter to add an instruction · Shift+Enter for a new line":
    "Enter — добавить инструкцию · Shift+Enter — новая строка",
  "Enter to send · Shift+Enter for a new line": "Enter — отправить · Shift+Enter — новая строка",
  "Entered text": "Текст введён",
  "Entering text": "Ввод текста",
  "Extra high": "Очень высокий",
  "File plain-text preview and compatibility warnings":
    "Предпросмотр текста файла и предупреждения о совместимости",
  "Find literal text on the page.": "Найти точный текст на странице.",
  "Find page text": "Найти текст страницы",
  "Find visible controls and scroll containers.":
    "Найти видимые элементы управления и прокручиваемые контейнеры.",
  "Finding page controls": "Поиск элементов управления страницы",
  "Finish or cancel element selection before sending":
    "Завершите или отмените выбор элемента перед отправкой",
  "Follow browser": "Как в браузере",
  Font: "Шрифт",
  "Font size": "Размер шрифта",
  "Found page controls": "Элементы управления страницы найдены",
  "HTTPS endpoint (no query or fragment)": "Конечная точка HTTPS (без запроса и фрагмента)",
  High: "Высокий",
  "Higher levels may use more tokens; model support varies.":
    "Более высокие уровни могут расходовать больше токенов; поддержка зависит от модели.",
  "How can I help?": "Чем я могу помочь?",
  "Image input": "Ввод изображений",
  "Image result": "Результат-изображение",
  "Import one UTF-8 SKILL.md file and review its plain text before saving. Scripts and supporting files are not supported. Static review cannot detect every unsupported dependency.":
    "Импортируйте один файл SKILL.md в UTF-8 и изучите его текст перед сохранением. Скрипты и вспомогательные файлы не поддерживаются. Статическая проверка не может выявить все неподдерживаемые зависимости.",
  "Import or replace": "Импортировать или заменить",
  "Import reviewed skill": "Импортировать проверенный навык",
  "Inspect a visible element.": "Изучить видимый элемент.",
  "Inspect element details": "Изучить сведения об элементе",
  "Installed skill limit is 20": "Предел установленных навыков — 20",
  "Installed skill plain-text preview": "Предпросмотр текста установленного навыка",
  "Installed skills": "Установленные навыки",
  "Instruction queued": "Инструкция добавлена в очередь",
  Instructions: "Инструкции",
  Interact: "Взаимодействие",
  Interrupted: "Прервано",
  "Invalid double-quoted frontmatter scalar; use JSON string syntax":
    "Недопустимое скалярное значение frontmatter в двойных кавычках; используйте синтаксис строк JSON",
  "Invalid or duplicate record": "Недопустимая или повторяющаяся запись",
  "Invalid record entry": "Недопустимый элемент записи",
  "Invalid records array": "Недопустимый массив записей",
  "Invalid single-quoted frontmatter scalar; escape quotes as two single quotes":
    "Недопустимое скалярное значение frontmatter в одинарных кавычках; экранируйте кавычку двумя одинарными кавычками",
  Language: "Язык",
  "Language changes apply after saving. Follow browser uses your preferred browser languages. English is the fallback.":
    "Язык меняется после сохранения. Режим «Как в браузере» использует предпочитаемые языки браузера. Резервный язык — английский.",
  "List the tools provided by this page through WebMCP?":
    "Показать инструменты, предоставленные этой страницей через WebMCP?",
  "List visible elements": "Показать видимые элементы",
  "List web tabs": "Показать веб-вкладки",
  "List web tabs in this window.": "Показать веб-вкладки в этом окне.",
  "Listening for voice input": "Ожидание голосового ввода",
  "Local file": "Локальный файл",
  Low: "Низкий",
  MCP: "MCP",
  "MCP authentication configuration is invalid": "Недопустимая конфигурация аутентификации MCP",
  "MCP connection changed or access was revoked":
    "Подключение MCP изменилось или доступ был отозван",
  "MCP endpoint is too long": "Конечная точка MCP слишком длинная",
  "MCP host access is required": "Нужен доступ к хосту MCP",
  "MCP request failed or was interrupted. Remote execution may be unknown. Review the server before making a new call; no call was retried.":
    "Запрос MCP завершился ошибкой или был прерван. Состояние удалённого выполнения может быть неизвестно. Проверьте сервер перед новым вызовом; ни один вызов не повторялся.",
  "MCP server changed before connection approval": "Сервер MCP изменился до одобрения подключения",
  "MCP server changed. Reload Settings before removing it.":
    "Сервер MCP изменился. Перезагрузите настройки перед его удалением.",
  "MCP server changed. Reload Settings before saving this edit.":
    "Сервер MCP изменился. Перезагрузите настройки перед сохранением этого изменения.",
  "MCP server limit reached": "Достигнут предел серверов MCP",
  "MCP server no longer exists": "Сервер MCP больше не существует",
  Maximum: "Максимальный",
  Medium: "Средний",
  Message: "Сообщение",
  "Microphone access failed: {error}": "Не удалось получить доступ к микрофону: {error}",
  "Microphone access is allowed. Close this tab and select the microphone in Pi Browser Agent.":
    "Доступ к микрофону разрешён. Закройте эту вкладку и выберите микрофон в Pi Browser Agent.",
  "Microphone access is blocked. Open Chrome microphone settings to allow it.":
    "Доступ к микрофону заблокирован. Откройте настройки микрофона Chrome, чтобы разрешить его.",
  "Microphone access was denied. Allow microphone access for Pi Browser Agent and try again.":
    "В доступе к микрофону отказано. Разрешите Pi Browser Agent доступ к микрофону и повторите попытку.",
  "Microphone access · Pi Browser Agent": "Доступ к микрофону · Pi Browser Agent",
  Minimal: "Минимальный",
  Model: "Модель",
  Monospace: "Моноширинный",
  Name: "Имя",
  "Name: {name}\n\nDescription: {description}\n\nBody:\n{body}":
    "Имя: {name}\n\nОписание: {description}\n\nСодержимое:\n{body}",
  Navigate: "Переход",
  "Navigate conversation branches": "Перейти по веткам беседы",
  "Navigate from {source} to {destination}?": "Перейти из {source} в {destination}?",
  "Navigate the current page.": "Выполнить переход на текущей странице.",
  "Never reuse approvals.": "Никогда не использовать одобрения повторно.",
  "New conversation": "Новая беседа",
  "New server": "Новый сервер",
  "New session": "Новый сеанс",
  "No active page": "Нет активной страницы",
  "No file reviewed.": "Файл не проверен.",
  "No file selected.": "Файл не выбран.",
  "No installed skill selected.": "Установленный навык не выбран.",
  "No matches": "Совпадений нет",
  "No microphone is available.": "Нет доступного микрофона.",
  "No models available. Add a credential to load this provider's catalog.":
    "Нет доступных моделей. Добавьте учётные данные, чтобы загрузить каталог этого поставщика.",
  "No providers available": "Нет доступных поставщиков",
  "No providers support API key authentication in Chrome":
    "Нет поставщиков, поддерживающих аутентификацию по ключу API в Chrome",
  "No providers support account login in Chrome":
    "Нет поставщиков, поддерживающих вход через аккаунт в Chrome",
  "No providers support this authentication method":
    "Нет поставщиков, поддерживающих этот способ аутентификации",
  "No reasoning": "Без рассуждений",
  "No servers configured.": "Серверы не настроены.",
  "No skills installed.": "Навыки не установлены.",
  "No specific warnings. Static review cannot detect every unsupported dependency.":
    "Особых предупреждений нет. Статическая проверка не может выявить все неподдерживаемые зависимости.",
  "No speech was detected.": "Речь не обнаружена.",
  "No tools returned": "Инструменты не получены",
  "No unsaved general changes": "Нет несохранённых общих изменений",
  "Not applicable": "Неприменимо",
  "Observed the page condition": "Условие страницы обнаружено",
  "Only this SKILL.md text is imported. Scripts are not executed and supporting files are not imported or available.":
    "Импортируется только этот текст SKILL.md. Скрипты не выполняются, вспомогательные файлы не импортируются и недоступны.",
  "Only viewport PNG screenshots can be annotated":
    "Пометки можно добавлять только к PNG-снимкам видимой области",
  "Open Chrome microphone settings": "Открыть настройки микрофона Chrome",
  "Open Pi Browser Agent": "Открыть Pi Browser Agent",
  "Open Pi Browser Agent and select a page element":
    "Открыть Pi Browser Agent и выбрать элемент страницы",
  "Open an HTTP or HTTPS page before granting site access":
    "Откройте страницу HTTP или HTTPS перед предоставлением доступа к сайту",
  "Open an HTTP or HTTPS page before selecting an element":
    "Откройте страницу HTTP или HTTPS перед выбором элемента",
  "Open an approved destination.": "Открыть одобренный адрес назначения.",
  "Open settings": "Открыть настройки",
  "Open the verification page and enter:": "Откройте страницу проверки и введите:",
  "Open verification page": "Открыть страницу проверки",
  "Open website": "Открыть сайт",
  "Open {url}? A search query in this URL will be sent to the destination.":
    "Открыть {url}? Поисковый запрос в этом URL будет отправлен по адресу назначения.",
  "OpenAI device login": "Вход в OpenAI через устройство",
  "OpenAI host access is required for login": "Для входа нужен доступ к хосту OpenAI",
  "OpenAI host access was revoked. Log in again to continue.":
    "Доступ к хосту OpenAI отозван. Войдите снова, чтобы продолжить.",
  "Opened a page": "Страница открыта",
  "Opening a page": "Открытие страницы",
  "Page activity completed": "Действия на странице завершены",
  "Page activity needs attention": "Действия на странице требуют внимания",
  "Page condition was not observed": "Условие страницы не обнаружено",
  "Page summary": "Сводка страницы",
  "Pasted image": "Вставленное изображение",
  "Pasted image {number}": "Вставленное изображение {number}",
  "Pen width": "Толщина пера",
  "Pi Browser Agent needs microphone access to turn speech into an editable prompt. Audio is processed by Chrome's speech service and is not sent to the selected model provider.":
    "Pi Browser Agent нужен доступ к микрофону, чтобы преобразовать речь в редактируемый запрос. Звук обрабатывает речевая служба Chrome; он не отправляется выбранному поставщику модели.",
  "Protected page": "Защищённая страница",
  Provider: "Поставщик",
  "Provider not configured": "Поставщик не настроен",
  "Providers available for sign in with an API key.":
    "Поставщики, доступные для входа по ключу API.",
  "Providers available for sign in with an account.":
    "Поставщики, доступные для входа через аккаунт.",
  "Queue for later": "Добавить в очередь на потом",
  "Radius host access is required to load its models":
    "Для загрузки моделей Radius нужен доступ к его хосту",
  Read: "Чтение",
  "Read current web-tab metadata.": "Прочитать метаданные текущей веб-вкладки.",
  "Read matching Chrome bookmark titles and URLs? Results will be sent to the selected model provider and saved in this session.":
    "Прочитать названия и URL подходящих закладок Chrome? Результаты будут отправлены выбранному поставщику модели и сохранены в этом сеансе.",
  "Read native option labels.": "Прочитать подписи стандартных вариантов выбора.",
  "Read native select options": "Прочитать варианты стандартного списка выбора",
  "Read page": "Прочитать страницу",
  "Read page · Sample content received.": "Прочитать страницу · Получено примерное содержимое.",
  "Read recent Chrome bookmark titles and URLs? Results will be sent to the selected model provider and saved in this session.":
    "Прочитать названия и URL недавних закладок Chrome? Результаты будут отправлены выбранному поставщику модели и сохранены в этом сеансе.",
  "Read recent bookmarks": "Прочитать недавние закладки",
  "Read recently added bookmarks.": "Прочитать недавно добавленные закладки.",
  "Read rendered page text.": "Прочитать отображаемый текст страницы.",
  "Read selected page text.": "Прочитать выделенный текст страницы.",
  "Read selection": "Прочитать выделение",
  "Read the page": "Прочитать страницу",
  "Read the selection": "Прочитать выделение",
  "Readable details": "Читаемые сведения",
  "Reading recent bookmarks": "Чтение недавних закладок",
  "Reading the page": "Чтение страницы",
  "Reading the selection": "Чтение выделения",
  Ready: "Готово",
  "Ready — no supported page open": "Готово — поддерживаемая страница не открыта",
  Reasoning: "Рассуждения",
  "Recent bookmarks": "Недавние закладки",
  "Recent sessions": "Недавние сеансы",
  "Refresh credential": "Обновить учётные данные",
  "Remember across restarts until cleared.": "Помнить после перезапусков до очистки.",
  "Remember until Chrome restarts.": "Помнить до перезапуска Chrome.",
  "Remembered approvals cleared": "Запомненные одобрения очищены",
  "Remote MCP call was declined": "Удалённый вызов MCP отклонён",
  "Remote MCP servers": "Удалённые серверы MCP",
  "Remote tool completed": "Удалённый инструмент завершён",
  "Remote tool needs attention": "Удалённый инструмент требует внимания",
  "Remove MCP server and token?": "Удалить сервер MCP и токен?",
  "Remove credential": "Удалить учётные данные",
  "Remove existing token": "Удалить существующий токен",
  "Remove images and selected elements before using a command":
    "Удалите изображения и выбранные элементы перед использованием команды",
  "Remove pasted image": "Удалить вставленное изображение",
  "Remove pasted image {number}": "Удалить вставленное изображение {number}",
  "Remove selected element {element}": "Удалить выбранный элемент {element}",
  "Remove server and token": "Удалить сервер и токен",
  "Remove “{name}”? Its stored token will be deleted.":
    "Удалить «{name}»? Сохранённый токен будет удалён.",
  "Remove “{name}”? Its stored token will be deleted. Unsaved changes will be discarded.":
    "Удалить «{name}»? Сохранённый токен будет удалён. Несохранённые изменения будут отброшены.",
  "Rename conversation": "Переименовать беседу",
  "Rename the current session": "Переименовать текущий сеанс",
  "Replace or remove the invalid MCP token explicitly":
    "Явно замените или удалите недопустимый токен MCP",
  "Replace selected skill": "Заменить выбранный навык",
  "Required browser access was not granted": "Необходимый доступ браузера не предоставлен",
  "Required model-provider or current-site access was not granted":
    "Необходимый доступ к поставщику модели или текущему сайту не предоставлен",
  "Review before import.": "Проверьте перед импортом.",
  "Review the name, description, body, and warnings before saving. Nothing has been imported.":
    "Проверьте имя, описание, содержимое и предупреждения перед сохранением. Ничего не импортировано.",
  "SKILL.md file": "Файл SKILL.md",
  "SKILL.md must be at most {bytes} bytes.": "Размер SKILL.md не должен превышать {bytes} байт.",
  "Sample content only. Nothing is sent or saved.":
    "Только пример содержимого. Ничего не отправляется и не сохраняется.",
  "Sample conversation": "Пример беседы",
  "Sans serif": "Без засечек",
  "Save disconnected": "Сохранить без подключения",
  "Save general settings": "Сохранить общие настройки",
  "Save general settings does not save MCP edits or import a reviewed skill. Use their save controls first, or discard those drafts and continue.":
    "«Сохранить общие настройки» не сохраняет изменения MCP и не импортирует проверенный навык. Сначала используйте их элементы сохранения либо отбросьте эти черновики и продолжите.",
  "Save server edits before testing the connection.":
    "Сохраните изменения сервера перед проверкой подключения.",
  "Save server edits disconnected before testing. Saving does not request host access.":
    "Перед проверкой сохраните изменения сервера без подключения. Сохранение не запрашивает доступ к хосту.",
  "Saved MCP configuration is invalid; no records were changed":
    "Сохранённая конфигурация MCP недопустима; записи не изменены",
  "Saved MCP servers": "Сохранённые серверы MCP",
  "Saved MCP token storage is invalid; no records were changed":
    "Сохранённое хранилище токенов MCP недопустимо; записи не изменены",
  "Saved conversations:": "Сохранённые беседы:",
  "Saved disconnected. Select Test and enable to make tools available for new runs.":
    "Сохранено без подключения. Выберите «Проверить и включить», чтобы инструменты стали доступны для новых запусков.",
  "Saved skill storage is invalid or exceeds limits; no records were changed":
    "Сохранённое хранилище навыков недопустимо или превышает ограничения; записи не изменены",
  "Saving disconnected…": "Сохранение без подключения…",
  "Saving general settings…": "Сохранение общих настроек…",
  "Saving…": "Сохранение…",
  "Screenshot annotation canvas": "Холст пометок на снимке экрана",
  "Scroll page or container": "Прокрутить страницу или контейнер",
  "Scroll the page or a container.": "Прокрутить страницу или контейнер.",
  "Scroll to latest message": "Перейти к последнему сообщению",
  Search: "Поиск",
  "Search bookmark titles and URLs.": "Искать в названиях и URL закладок.",
  "Search bookmarks": "Поиск в закладках",
  "Search models": "Поиск моделей",
  "Search providers": "Поиск поставщиков",
  "Searched bookmarks": "Поиск в закладках выполнен",
  "Searching bookmarks": "Поиск в закладках",
  "Select Allow microphone access, then approve Chrome's prompt.":
    "Выберите «Разрешить доступ к микрофону», затем подтвердите запрос Chrome.",
  "Select Save disconnected to save server edits and disable the server. Server actions save separately from Save general settings. Cancel does not undo saved server changes.":
    "Выберите «Сохранить без подключения», чтобы сохранить изменения и отключить сервер. Действия сервера сохраняются отдельно от общих настроек. Отмена не отменяет сохранённые изменения сервера.",
  "Select a provider before configuring it": "Выберите поставщика перед его настройкой",
  "Select a user message to edit it, or a completed response to continue there. Other branches are kept. Previous browser actions are not undone.":
    "Выберите сообщение пользователя для редактирования или завершённый ответ, чтобы продолжить с него. Другие ветки сохраняются. Предыдущие действия браузера не отменяются.",
  "Select authentication method": "Выберите способ аутентификации",
  "Select native option": "Выбрать стандартный вариант",
  "Select one UTF-8 text file named SKILL.md.":
    "Выберите один текстовый файл UTF-8 с именем SKILL.md.",
  "Select page element": "Выбрать элемент страницы",
  "Select page element ({shortcut})": "Выбрать элемент страницы ({shortcut})",
  "Select provider": "Выбрать поставщика",
  "Selected a page control": "Элемент управления страницы выбран",
  "Selected element context exceeds the 16 KB composer limit":
    "Контекст выбранного элемента превышает предел поля ввода 16 KB",
  "Selected element is missing its page context":
    "У выбранного элемента отсутствует контекст страницы",
  "Selected skill": "Выбранный навык",
  "Selected skill replaced and disabled. Changes apply to the next run.":
    "Выбранный навык заменён и отключён. Изменения действуют со следующего запуска.",
  "Selecting a page control": "Выбор элемента управления страницы",
  Send: "Отправить",
  "Send selection to Pi Browser Agent": "Отправить выделение в Pi Browser Agent",
  "Separate action in progress…": "Выполняется отдельное действие…",
  Serif: "С засечками",
  "Server actions save separately. Cancel does not undo saved changes. Tool data can go to your model and saved session.":
    "Действия сервера сохраняются отдельно. Отмена не отменяет сохранённые изменения. Данные инструментов могут передаваться вашей модели и в сохранённый сеанс.",
  "Server edits not saved": "Изменения сервера не сохранены",
  "Server requirements and data sharing": "Требования сервера и передача данных",
  "Set checked state": "Задать состояние флажка",
  "Set the assistant's general role and behavior.": "Задайте общую роль и поведение помощника.",
  Settings: "Настройки",
  "Settings saved": "Настройки сохранены",
  "Settings sections": "Разделы настроек",
  "Settings · Pi Browser Agent": "Настройки · Pi Browser Agent",
  "Sign in to a model provider": "Войти к поставщику модели",
  "Sign in with an API key": "Войти по ключу API",
  "Sign in with an account": "Войти через аккаунт",
  "Sign out of the selected model provider": "Выйти из аккаунта выбранного поставщика модели",
  "Site access is required for that destination":
    "Для этого адреса назначения нужен доступ к сайту",
  "Site access is required to select an element": "Для выбора элемента нужен доступ к сайту",
  "Site access is required to work with the current page":
    "Для работы с текущей страницей нужен доступ к сайту",
  "Skill actions save separately. Cancel does not undo saved changes. Imports and replacements start disabled.":
    "Действия с навыками сохраняются отдельно. Отмена не отменяет сохранённые изменения. Импортированные и заменённые навыки изначально отключены.",
  "Skill body must contain valid Unicode text without control characters":
    "Содержимое навыка должно быть допустимым текстом Unicode без управляющих символов",
  "Skill content exceeds the 65536-byte limit": "Содержимое навыка превышает предел 65536 байт",
  "Skill deleted. Previous session history is retained.":
    "Навык удалён. История предыдущих сеансов сохраняется.",
  "Skill description must be one line of 1 to 512 characters without surrounding whitespace":
    "Описание навыка должно занимать одну строку длиной от 1 до 512 символов без пробельных символов по краям",
  "Skill disabled for the next run.": "Навык отключён для следующего запуска.",
  "Skill enabled for the next run.": "Навык включён для следующего запуска.",
  "Skill enabled state must be a boolean":
    "Состояние включения навыка должно быть логическим значением",
  "Skill frontmatter requires name and description":
    "В блоке frontmatter навыка обязательны name и description",
  "Skill imported disabled. Review and enable it for the next run.":
    "Навык импортирован отключённым. Изучите и включите его для следующего запуска.",
  "Skill input exceeds the 65536-byte limit": "Входные данные навыка превышают предел 65536 байт",
  "Skill input must be valid UTF-8 text":
    "Входные данные навыка должны быть допустимым текстом UTF-8",
  "Skill must start with frontmatter enclosed by --- delimiter lines":
    "Навык должен начинаться с блока frontmatter между строками-разделителями ---",
  "Skill name must be lowercase kebab-case, at most 64 characters":
    "Имя навыка должно быть в формате kebab-case в нижнем регистре, не более 64 символов",
  "Skill no longer exists": "Навык больше не существует",
  "Skill requirements and data sharing": "Требования навыка и передача данных",
  "Skill review not imported": "Проверенный навык не импортирован",
  "Skill storage exceeds the 524288-byte limit": "Хранилище навыков превышает предел 524288 байт",
  Skills: "Навыки",
  "Skills can affect model behavior but cannot override safety rules or grant permissions. Enabled skill names, descriptions, and loaded content are shared with the selected model provider only when you submit a chat message. They can remain in saved session history after you disable or delete a skill.":
    "Навыки могут влиять на поведение модели, но не могут отменять правила безопасности или предоставлять разрешения. Имена, описания и загруженное содержимое включённых навыков передаются выбранному поставщику модели только при отправке сообщения в чат. Они могут остаться в сохранённой истории сеанса после отключения или удаления навыка.",
  "Skills save independently. Imported skills start disabled.":
    "Навыки сохраняются независимо. Импортированные навыки изначально отключены.",
  "Slash commands": "Команды с косой чертой",
  "Slash commands must use a single line.": "Команда с косой чертой должна занимать одну строку.",
  "Start a new session": "Начать новый сеанс",
  "Start of conversation": "Начало беседы",
  "Start voice input": "Начать голосовой ввод",
  Stop: "Остановить",
  "Stop voice input": "Остановить голосовой ввод",
  "Stop voice input before sending": "Остановите голосовой ввод перед отправкой",
  Strict: "Строгий",
  "Submits, downloads, native option selections, actual checkbox/radio changes, and clicks without a stable target always ask. Remote MCP calls require fresh confirmation in every mode.":
    "Отправка форм, загрузки, выбор стандартных вариантов, фактические изменения флажков и переключателей, а также нажатия без стабильной цели всегда требуют подтверждения. Удалённые вызовы MCP требуют нового подтверждения в любом режиме.",
  "Summarize this page.": "Кратко изложи эту страницу.",
  "Switch to a web tab.": "Переключиться на веб-вкладку.",
  "Switch web tab": "Переключить веб-вкладку",
  "System default": "Системный по умолчанию",
  "System prompt": "Системный запрос",
  Table: "Таблица",
  "Technical name": "Техническое имя",
  "Test and enable": "Проверить и включить",
  "Test and enable checks the connection. A successful check enables the server for new runs and shows a tool preview.":
    "«Проверить и включить» проверяет подключение. Успешная проверка включает сервер для новых запусков и показывает предпросмотр инструментов.",
  "Test and enable requests host access and checks the saved endpoint. No tool is called.":
    "«Проверить и включить» запрашивает доступ к хосту и проверяет сохранённую конечную точку. Инструменты не вызываются.",
  "Testing saved endpoint…": "Проверка сохранённой конечной точки…",
  "Text input": "Текстовый ввод",
  "The annotated screenshot must use 3 MB or less":
    "Размер снимка экрана с пометками не должен превышать 3 MB",
  "The conversation changed. Enter the command again.": "Беседа изменилась. Введите команду снова.",
  "The conversation changed. Open /tree again.": "Беседа изменилась. Откройте /tree снова.",
  "The conversation or draft changed. Open /tree again.":
    "Беседа или черновик изменились. Откройте /tree снова.",
  "The current task finished before the instruction could be queued. Send it again.":
    "Текущая задача завершилась до добавления инструкции в очередь. Отправьте её снова.",
  "The eight-server limit is reached. Select a saved server to edit or remove it.":
    "Достигнут предел в восемь серверов. Выберите сохранённый сервер, чтобы изменить или удалить его.",
  "The page changed before selected elements could be sent. Select them again.":
    "Страница изменилась до отправки выбранных элементов. Выберите их снова.",
  "The page changed before selection could start. Select it again.":
    "Страница изменилась до начала выбора. Выберите снова.",
  "The page changed while access was being granted. Send the prompt again.":
    "Страница изменилась во время предоставления доступа. Отправьте запрос снова.",
  "The page changed while site access was being granted. Select it again.":
    "Страница изменилась во время предоставления доступа к сайту. Выберите снова.",
  "The same operation and target/arguments can run again without a dialog after Chrome restarts, until cleared in Settings.":
    "Та же операция с той же целью и аргументами может выполняться повторно без диалога и после перезапуска Chrome, пока одобрение не будет очищено в настройках.",
  "The same operation and target/arguments can run again without a dialog until Chrome restarts.":
    "Та же операция с той же целью и аргументами может выполняться повторно без диалога до перезапуска Chrome.",
  "The screenshot dimensions are inconsistent": "Размеры снимка экрана не согласованы",
  "The screenshot dimensions are too large to annotate safely":
    "Размеры снимка экрана слишком велики для безопасного добавления пометок",
  "The screenshot image is invalid": "Недопустимое изображение снимка экрана",
  "The selected provider changed. Try again.": "Выбранный поставщик изменился. Повторите попытку.",
  "The selected skill changed. Select and review it again.":
    "Выбранный навык изменился. Выберите и проверьте его снова.",
  "These controls save independently of Save general settings and Cancel. Changes apply to the next run, not an active run. Imported and replaced skills start disabled.":
    "Эти элементы сохраняют изменения независимо от «Сохранить общие настройки» и «Отмена». Изменения действуют со следующего запуска, а не в текущем. Импортированные и заменённые навыки изначально отключены.",
  "These instructions apply to the next run.": "Эти инструкции действуют со следующего запуска.",
  Thinking: "Размышление",
  "Thinking level": "Уровень размышления",
  "This annotation reached its total point limit": "Достигнут общий предел точек этой аннотации",
  "This click may submit a form, download a file, or navigate across origins":
    "Это нажатие может отправить форму, скачать файл или выполнить переход между источниками",
  "This is how answers, lists, and code will look with your selected font.":
    "Так будут выглядеть ответы, списки и код с выбранным шрифтом.",
  "This model does not use a thinking level. Your saved preference is retained.":
    "Эта модель не использует уровень размышления. Сохранённое предпочтение сохраняется.",
  "This removes the installed skill for future runs. It does not remove content from previous session history.":
    "Это удалит установленный навык для будущих запусков. Содержимое истории предыдущих сеансов не удаляется.",
  "This skill may require scripts, local tools, or supporting files that are not available. This heuristic warning is not a complete dependency check.":
    "Этот навык может требовать недоступные скрипты, локальные инструменты или вспомогательные файлы. Это эвристическое предупреждение не является полной проверкой зависимостей.",
  "This slash command does not accept arguments.":
    "Эта команда с косой чертой не принимает аргументы.",
  "This stroke reached its point limit; start another stroke":
    "Достигнут предел точек этого штриха; начните новый штрих",
  "This turn does not use page context": "В этом ходе контекст страницы не используется",
  "Too many records": "Слишком много записей",
  "Tool result": "Результат инструмента",
  Tools: "Инструменты",
  "Type text": "Ввести текст",
  "UTF-8 text, at most 64 KiB. Review all file content and warnings below. Import adds a new disabled skill. Replace selected skill confirms replacement of the selected installed skill with the reviewed file and disables it.":
    "Текст UTF-8, не более 64 KiB. Изучите всё содержимое файла и предупреждения ниже. Импорт добавляет новый отключённый навык. «Заменить выбранный навык» подтверждает замену выбранного установленного навыка проверенным файлом и отключает его.",
  "Unable to export the annotation": "Не удалось экспортировать пометки",
  "Unavailable boundary": "Недоступная граница",
  Undo: "Отменить действие",
  "Unknown slash command.": "Неизвестная команда с косой чертой.",
  "Unsaved MCP edits. Select Save disconnected.":
    "Есть несохранённые изменения MCP. Выберите «Сохранить без подключения».",
  "Unsaved MCP or Skills changes": "Несохранённые изменения MCP или навыков",
  "Unsaved general changes": "Несохранённые общие изменения",
  "Unsaved general settings, MCP edits, and reviewed skill content will be discarded. Saved MCP and Skills changes will remain.":
    "Несохранённые общие настройки, изменения MCP и проверенное содержимое навыка будут отброшены. Сохранённые изменения MCP и навыков останутся.",
  "Unsupported YAML frontmatter; use unindented name and description scalars":
    "Неподдерживаемый блок YAML frontmatter; используйте скалярные значения name и description без отступов",
  "Unsupported YAML scalar; use a plain string or a quoted string":
    "Неподдерживаемое скалярное значение YAML; используйте обычную строку или строку в кавычках",
  "Unsupported envelope": "Неподдерживаемая оболочка",
  "Untrusted MCP tool preview": "Недоверенный предпросмотр инструментов MCP",
  "Update credential": "Изменить учётные данные",
  "Use a public HTTPS hostname without credentials, query, or fragment":
    "Используйте общедоступное имя хоста HTTPS без учётных данных, запроса и фрагмента",
  "Use the tab {title}?": "Использовать вкладку {title}?",
  "Used a page feature": "Функция страницы использована",
  User: "Пользователь",
  "Using a page feature": "Использование функции страницы",
  "Voice input is not supported by this browser": "Этот браузер не поддерживает голосовой ввод",
  "Voice input stopped": "Голосовой ввод остановлен",
  "Voice recognition could not reach Chrome's speech service.":
    "Распознаванию речи не удалось связаться с речевой службой Chrome.",
  "Voice recognition could not start.": "Не удалось запустить распознавание речи.",
  "Voice recognition could not stop.": "Не удалось остановить распознавание речи.",
  "Voice recognition is blocked by Chrome.": "Распознавание речи заблокировано Chrome.",
  "Voice recognition stopped unexpectedly.": "Распознавание речи неожиданно остановилось.",
  "Wait for a page condition.": "Дождаться условия страницы.",
  "Wait for conversation initialization": "Дождитесь инициализации беседы",
  "Wait for page condition": "Дождаться условия страницы",
  "Wait for the current operation to finish before sending":
    "Дождитесь завершения текущей операции перед отправкой",
  "Wait for the current operation to finish before using a command":
    "Дождитесь завершения текущей операции перед использованием команды",
  "Wait for the current server action to finish.":
    "Дождитесь завершения текущего действия сервера.",
  "Wait for the microphone access check to finish":
    "Дождитесь завершения проверки доступа к микрофону",
  "Wait for the pasted image preview before sending":
    "Дождитесь предпросмотра вставленного изображения перед отправкой",
  "Waiting for Chrome's microphone prompt…": "Ожидание запроса Chrome на доступ к микрофону…",
  "Waiting for a page condition": "Ожидание условия страницы",
  "Waiting for a web page": "Ожидание веб-страницы",
  "Web page": "Веб-страница",
  WebMCP: "WebMCP",
  Working: "В работе",
  "Working with the page": "Работа со страницей",
  "Working…": "В работе…",
  You: "Вы",
  "[details truncated]": "[сведения сокращены]",
  "[image unavailable: {mimeType}]": "[изображение недоступно: {mimeType}]",
  "available with site access": "доступно при разрешении доступа к сайту",
  "the provider": "поставщик",
  "{model} does not support image input": "{model} не поддерживает ввод изображений",
  "{preview}\n\nCompatibility warnings:\n{warnings}":
    "{preview}\n\nПредупреждения о совместимости:\n{warnings}",
  "{provider} configured with an API key": "{provider}: настроен вход по ключу API",
  "{provider} configured with an account": "{provider}: настроен вход через аккаунт",
  "{provider} credential configured — API key": "{provider}: учётные данные настроены — ключ API",
  "{provider} credential configured — Account": "{provider}: учётные данные настроены — аккаунт",
  "{provider} credential missing": "{provider}: отсутствуют учётные данные",
  "{provider} not configured": "{provider}: не настроено",
  "GitHub repository": "Репозиторий GitHub",
  "Enter owner/repo or a GitHub repository URL. Only public repositories are supported.":
    "Введите owner/repo или URL репозитория GitHub. Поддерживаются только общедоступные репозитории.",
  "Find GitHub skills": "Найти навыки GitHub",
  "Cancel fetch": "Отменить получение",
  "GitHub SKILL.md files": "Файлы SKILL.md на GitHub",
  "Select a SKILL.md": "Выбрать SKILL.md",
  "Review selected GitHub skill": "Проверить выбранный навык GitHub",
  "Open source on GitHub": "Открыть исходный файл на GitHub",
  "Only name, description, and body are saved. Source identity and optional metadata are review-only.":
    "Сохраняются только name, description и body. Сведения об источнике и необязательные metadata доступны только для проверки.",
  "Repository: {repository}\nPath: {path}\nCommit: {commit}":
    "Репозиторий: {repository}\nПуть: {path}\nКоммит: {commit}",
  "Original SKILL.md:\n{source}": "Исходный SKILL.md:\n{source}",
  "GitHub results: {total}. Select one SKILL.md to review.":
    "Результаты GitHub: {total}. Выберите один SKILL.md для проверки.",
  "No SKILL.md files found at the repository root or under skills/.":
    "Файлы SKILL.md не найдены в корне репозитория или в skills/.",
  "GitHub fetch cancelled.": "Получение из GitHub отменено.",
  "Repository changed. Find GitHub skills again.":
    "Репозиторий изменился. Найдите навыки GitHub снова.",
  "Select a GitHub SKILL.md to review.": "Выберите SKILL.md на GitHub для проверки.",
  "GitHub access was not granted. Local file import is still available.":
    "Доступ к GitHub не предоставлен. Импорт локальных файлов по-прежнему доступен.",
  "GitHub access starts with Find GitHub skills. Requests use api.github.com without cookies or credentials. Only the selected SKILL.md is downloaded; scripts and supporting files are not imported.":
    "Доступ к GitHub начинается при выборе «Найти навыки GitHub». Запросы используют api.github.com без файлов cookie и учётных данных. Загружается только выбранный SKILL.md; скрипты и вспомогательные файлы не импортируются.",
  "Skill frontmatter exceeds 8 container levels or 256 nodes":
    "Блок frontmatter навыка превышает 8 уровней контейнеров или 256 узлов",
  "Skill frontmatter must not contain tags, anchors, aliases, directives, or document markers":
    "Блок frontmatter навыка не должен содержать теги, якоря, псевдонимы, директивы или маркеры документов",
  "Invalid YAML frontmatter": "Недопустимый блок YAML frontmatter",
  "Skill frontmatter requires one YAML document":
    "Блок frontmatter навыка должен содержать один документ YAML",
  "Skill frontmatter must contain valid Unicode text without control characters":
    "Блок frontmatter навыка должен содержать допустимый текст Unicode без управляющих символов",
  "Skill frontmatter must be a mapping with string keys":
    "Блок frontmatter навыка должен быть отображением со строковыми ключами",
  "Skill frontmatter fields must be name, description, license, compatibility, metadata, or allowed-tools":
    "Поля блока frontmatter навыка должны быть name, description, license, compatibility, metadata или allowed-tools",
  "Skill frontmatter values must be strings; metadata must be a string-to-string map":
    "Значения блока frontmatter навыка должны быть строками; metadata должно быть отображением строк в строки",
  "Skill compatibility must be at most 500 characters":
    "Поле compatibility навыка должно содержать не более 500 символов",
  "Enter a GitHub repository as owner/repo or an HTTPS repository-root URL":
    "Введите репозиторий GitHub в виде owner/repo или HTTPS URL корня репозитория",
  "Invalid GitHub response": "Недопустимый ответ GitHub",
  "Invalid GitHub skill selection": "Недопустимый выбор навыка GitHub",
  "GitHub API host approval is required": "Требуется одобрение доступа к хосту GitHub API",
  "GitHub read cancelled": "Чтение из GitHub отменено",
  "GitHub tree is truncated; no partial listing is available":
    "Дерево GitHub усечено; частичный список недоступен",
  "GitHub tree exceeds the 10000-entry limit": "Дерево GitHub превышает предел в 10000 записей",
  "GitHub listing exceeds the 200-candidate limit":
    "Список GitHub превышает предел в 200 кандидатов",
  "GitHub read timed out after 30 seconds":
    "Время ожидания чтения из GitHub истекло через 30 секунд",
  "GitHub request failed; check the canonical repository and host access. Redirects are not allowed":
    "Запрос к GitHub не выполнен; проверьте канонический репозиторий и доступ к хосту. Перенаправления запрещены",
  "GitHub redirected the request; enter the canonical repository":
    "GitHub перенаправил запрос; введите канонический репозиторий",
  "GitHub repository or object is unavailable": "Репозиторий или объект GitHub недоступен",
  "GitHub API access was denied or rate limited":
    "Доступ к GitHub API запрещён или ограничен по частоте запросов",
  "GitHub request failed": "Запрос к GitHub не выполнен",
  "GitHub response exceeds the received-byte limit":
    "Ответ GitHub превышает предел полученных байтов",
  "GitHub skill exceeds the 65536-byte source limit":
    "Навык GitHub превышает предел исходного файла в 65536 байт",
  "Invalid GitHub skill Base64": "Недопустимые данные Base64 навыка GitHub",
  "GitHub skill must be valid UTF-8 text": "Навык GitHub должен быть допустимым текстом UTF-8",
} satisfies Catalog
