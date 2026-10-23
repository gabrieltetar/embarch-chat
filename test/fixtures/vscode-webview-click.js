// VS Code's own click handler for a webview's page, verbatim from VS Code
// 1.143.1 (MIT), resources/app/out/vs/workbench/contrib/webview/browser/pre/index.html.
// VS Code adds it to every webview's window (`contentWindow.addEventListener
// ('click', handleInnerClick)`): a trusted click on an <a> with an href posts
// `did-click-link`, and the workbench opens that URI itself (http, https,
// mailto, vscode, vscode-insiders) — whatever the page's own handler did.
// The e2e test sets it on its page, with `hostMessaging` recording what it
// would post, to show no link here ever reaches it.
		const handleInnerClick = (event) => {
			if (!event.isTrusted || !event?.view?.document) {
				return;
			}

			const baseElement = event.view.document.querySelector('base');

			for (const pathElement of event.composedPath()) {
				/** @type {any} */
				const node = pathElement;
				if (node.tagName && node.tagName.toLowerCase() === 'a' && node.href) {
					if (node.getAttribute('href') === '#') {
						event.view.scrollTo(0, 0);
					} else if (node.hash && (node.getAttribute('href') === node.hash || (baseElement && node.href === baseElement.href + node.hash))) {
						const fragment = node.hash.slice(1);
						const decodedFragment = decodeURIComponent(fragment);
						const scrollTarget = event.view.document.getElementById(fragment) ?? event.view.document.getElementById(decodedFragment);
						if (scrollTarget) {
							scrollTarget.scrollIntoView();
						} else if (decodedFragment.toLowerCase() === 'top') {
							event.view.scrollTo(0, 0);
						}
					} else {
						hostMessaging.postMessage('did-click-link', { uri: node.href.baseVal || node.href });
					}
					event.preventDefault();
					return;
				}
			}
		};

