import React, {ComponentType, JSXElementConstructor} from 'react';
import {
  // @ts-ignore
  renderToPipeableStream, // Only available in Node context
  // @ts-ignore
  renderToReadableStream, // Only available in Browser/Worker context
} from 'react-dom/server';
import {renderToString} from 'react-dom/server';
import {getErrorMarkup} from './utilities/error';
import ssrPrepass from 'react-ssr-prepass';
import type {ServerHandler} from './types';
import type {ReactQueryHydrationContext} from './foundation/ShopifyProvider/types';
// import {FilledContext, HelmetProvider} from 'react-helmet-async';
import {Html} from './framework/Hydration/Html';
import {HydrationWriter} from './framework/Hydration/writer.server';
import {Renderer, Hydrator, Streamer} from './types';
import {ServerComponentResponse} from './framework/Hydration/ServerComponentResponse.server';
import {ServerComponentRequest} from './framework/Hydration/ServerComponentRequest.server';
import {dehydrate} from 'react-query/hydration';
import {getCacheControlHeader} from './framework/cache';
import {ServerRequestProvider} from './foundation/ServerRequestProvider';
import type {ServerResponse} from 'http';

import {
  rscRenderToPipeableStream,
  rscRenderToReadableStream,
} from './framework/Hydration/rsc-server-renderer';

/**
 * react-dom/unstable-fizz provides different entrypoints based on runtime:
 * - `renderToReadableStream` for "browser" (aka worker)
 * - `pipeToNodeWritable` for node.js
 */
const isWorker = Boolean(renderToReadableStream);

const wrapInFlightContainer = ({
  init,
  chunk,
  nonce,
}: {
  init?: boolean;
  chunk?: string;
  nonce?: string;
}) =>
  `<script${nonce ? ` nonce="${nonce}"` : ''}>window.__flight${
    init ? '=[]' : `.push(\`${chunk}\`)`
  }</script>`;

/**
 * If a query is taking too long, or something else went wrong,
 * send back a response containing the Suspense fallback and rely
 * on the client to hydrate and build the React tree.
 */
const STREAM_ABORT_TIMEOUT_MS = 3000;

const renderHydrogen: ServerHandler = (App, hook) => {
  /**
   * The render function is responsible for turning the provided `App` into an HTML string,
   * and returning any initial state that needs to be hydrated into the client version of the app.
   * NOTE: This is currently only used for SEO bots or Worker runtime (where Stream is not yet supported).
   */
  const render: Renderer = async function (
    url,
    {context, request, isReactHydrationRequest, dev}
  ) {
    const state = isReactHydrationRequest
      ? JSON.parse(url.searchParams?.get('state') ?? '{}')
      : {pathname: url.pathname, search: url.search};

    const {ReactApp, /*helmetContext,*/ componentResponse} = buildReactApp({
      App,
      state,
      context,
      request,
      dev,
    });

    const body = isReactHydrationRequest
      ? '' // TODO: Implement RSC without streaming -- Or wait until ReadableStream is supported
      : await renderApp(ReactApp, state);

    if (componentResponse.customBody) {
      return {body: await componentResponse.customBody, url, componentResponse};
    }

    let params = {url /*, ...extractHeadElements(helmetContext)*/};

    /**
     * We allow the developer to "hook" into this process and mutate the params.
     */
    if (hook) {
      params = hook(params) || params;
    }

    return {body, componentResponse, ...params};
  };

  /**
   * Stream a response to the client. NOTE: This omits custom `<head>`
   * information, so this method should not be used by crawlers.
   */
  const stream: Streamer = async function (
    url: URL,
    {context, request, response, template, dev}
  ) {
    const state = {pathname: url.pathname, search: url.search};

    // App for RSC rendering
    const {ReactApp: ReactAppRSC} = buildReactApp({
      App,
      state,
      context,
      request,
      dev,
      isRSC: true,
    });

    if (rscRenderToPipeableStream) {
      // Node.js branch

      const {pipe} = rscRenderToPipeableStream(<ReactAppRSC {...state} />);

      let flightResponseBuffer = '';
      const {PassThrough} = await import('stream');
      const writer = new PassThrough();
      writer.setEncoding('utf-8');
      writer.on('data', (chunk: string) => {
        if (response.headersSent) {
          if (flightResponseBuffer) {
            chunk = flightResponseBuffer + chunk;
            flightResponseBuffer = '';
          }

          response.write(wrapInFlightContainer({chunk}));
        } else {
          flightResponseBuffer += chunk;
        }
      });
      pipe(writer);
    } else {
      // Worker branch
      // TODO implement RSC with TransformStream?
    }

    // App for SSR rendering
    const {ReactApp, componentResponse} = buildReactApp({
      App,
      state,
      context,
      request,
      dev,
    });

    response.socket!.on('error', (error: any) => {
      console.error('Fatal', error);
    });

    let didError: Error | undefined;

    const head =
      (template.match(/<head>(.+?)<\/head>/s)![1] || '') +
      wrapInFlightContainer({init: true});

    const {pipe, abort} = renderToPipeableStream(
      <Html head={head}>
        <ReactApp {...state} />
      </Html>,
      {
        onCompleteShell() {
          /**
           * TODO: This assumes `response.cache()` has been called _before_ any
           * queries which might be caught behind Suspense. Clarify this or add
           * additional checks downstream?
           */
          response.setHeader(
            getCacheControlHeader({dev}),
            componentResponse.cacheControlHeader
          );

          writeHeadToServerResponse(response, componentResponse, didError);
          if (isRedirect(response)) {
            // Return redirects early without further rendering/streaming
            return response.end();
          }

          if (!componentResponse.canStream()) return;

          startWritingHtmlToServerResponse(
            response,
            pipe,
            dev ? didError : undefined
          );
        },
        onCompleteAll() {
          if (componentResponse.canStream() || response.writableEnded) return;

          writeHeadToServerResponse(response, componentResponse, didError);
          if (isRedirect(response)) {
            // Redirects found after any async code
            return response.end();
          }

          if (componentResponse.customBody) {
            if (componentResponse.customBody instanceof Promise) {
              componentResponse.customBody.then((body) => response.end(body));
            } else {
              response.end(componentResponse.customBody);
            }
          } else {
            startWritingHtmlToServerResponse(
              response,
              pipe,
              dev ? didError : undefined
            );
          }
        },
        onError(error: any) {
          didError = error;

          if (dev && response.headersSent) {
            // Calling write would flush headers automatically.
            // Delay this error until headers are properly sent.
            response.write(getErrorMarkup(error));
          }

          console.error(error);
        },
      }
    );

    setTimeout(abort, STREAM_ABORT_TIMEOUT_MS);
  };

  /**
   * Stream a hydration response to the client.
   */
  const hydrate: Hydrator = function (
    url: URL,
    {context, request, response, dev}
  ) {
    const state = JSON.parse(url.searchParams.get('state') || '{}');

    const {ReactApp} = buildReactApp({
      App,
      state,
      context,
      request,
      dev,
      isRSC: true,
    });

    response.socket!.on('error', (error: any) => {
      console.error('Fatal', error);
    });

    if (rscRenderToPipeableStream) {
      rscRenderToPipeableStream(<ReactApp {...state} />).pipe(response);
    } else if (rscRenderToReadableStream) {
      const stream = rscRenderToReadableStream(<ReactApp {...state} />);
      // TODO: How do we pipe the stream to the response?
      return new Response(stream);
    }
  };

  return {
    render,
    stream,
    hydrate,
  };
};

function buildReactApp({
  App,
  state,
  context,
  request,
  dev,
  isRSC = false,
}: {
  App: ComponentType;
  state: any;
  context: any;
  request: ServerComponentRequest;
  dev: boolean | undefined;
  isRSC?: boolean;
}) {
  // const helmetContext = {} as FilledContext;
  const componentResponse = new ServerComponentResponse();

  const ReactApp = (props: any) => (
    <ServerRequestProvider request={request} isRSC={isRSC}>
      <App {...props} request={request} response={componentResponse} />
    </ServerRequestProvider>
  );

  return {/*helmetContext,*/ ReactApp, componentResponse};
}

// function extractHeadElements(helmetContext: FilledContext) {
//   const {helmet} = helmetContext;

//   return {
//     base: helmet.base.toString(),
//     bodyAttributes: helmet.bodyAttributes.toString(),
//     htmlAttributes: helmet.htmlAttributes.toString(),
//     link: helmet.link.toString(),
//     meta: helmet.meta.toString(),
//     noscript: helmet.noscript.toString(),
//     script: helmet.script.toString(),
//     style: helmet.style.toString(),
//     title: helmet.title.toString(),
//   };
// }

function supportsReadableStream() {
  try {
    new ReadableStream();
    return true;
  } catch (_e) {
    return false;
  }
}

async function renderApp(ReactApp: JSXElementConstructor<any>, state: any) {
  /**
   * Temporary workaround until all Worker runtimes support ReadableStream
   */
  if (isWorker && !supportsReadableStream()) {
    return renderAppFromStringWithPrepass(ReactApp, state);
  }

  return renderAppFromBufferedStream(ReactApp, state);
}

function renderAppFromBufferedStream(
  ReactApp: JSXElementConstructor<any>,
  state: any
) {
  const app = <ReactApp {...state} />;

  return new Promise<string>((resolve, reject) => {
    if (isWorker) {
      let isComplete = false;

      const stream = renderToReadableStream(app, {
        onCompleteAll() {
          isComplete = true;
        },
        onError(error: any) {
          console.error(error);
          reject(error);
        },
      }) as ReadableStream;

      /**
       * We want to wait until `onCompleteAll` has been called before fetching the
       * stream body. Otherwise, React 18's streaming JS script/template tags
       * will be included in the output and cause issues when loading
       * the Client Components in the browser.
       */
      async function checkForResults() {
        if (!isComplete) {
          setTimeout(checkForResults, 100);
          return;
        }

        /**
         * Use the stream to build a `Response`, and fetch the body from the response
         * to resolve and be processed by the rest of the pipeline.
         */
        const res = new Response(stream);
        resolve(await res.text());
      }

      checkForResults();
    } else {
      const writer = new HydrationWriter();

      const {pipe} = renderToPipeableStream(app, {
        /**
         * When hydrating, we have to wait until `onCompleteAll` to avoid having
         * `template` and `script` tags inserted and rendered as part of the hydration response.
         */
        onCompleteAll() {
          // Tell React to start writing to the writer
          pipe(writer);

          // Tell React that the writer is ready to drain, which sometimes results in a last "chunk" being written.
          writer.drain();

          resolve(writer.toString());
        },
        onError(error: any) {
          console.error(error);
          reject(error);
        },
      });
    }
  });
}

/**
 * If we can't render a "blocking" response by buffering React's SSR
 * streaming functionality (likely due to lack of support for a primitive
 * in the runtime), we fall back to using `renderToString`. By default,
 * `renderToString` stops at Suspense boundaries and will not
 * keep trying them until they resolve. This means have to
 * use ssr-prepass to fetch all the queries once, store
 * the results in a context object, and re-render.
 */
async function renderAppFromStringWithPrepass(
  ReactApp: JSXElementConstructor<any>,
  state: any
) {
  const hydrationContext: ReactQueryHydrationContext = {};

  const app = <ReactApp hydrationContext={hydrationContext} {...state} />;

  await ssrPrepass(app);

  /**
   * Dehydrate all the queries made during the prepass above and store
   * them in the context object to be used for the next render pass.
   * This prevents rendering the Suspense fallback in `renderToString`.
   */
  if (hydrationContext.queryClient) {
    hydrationContext.dehydratedState = dehydrate(hydrationContext.queryClient);
  }

  return renderToString(app);
}

export default renderHydrogen;

function startWritingHtmlToServerResponse(
  response: ServerResponse,
  pipe: (r: ServerResponse) => void,
  error?: Error
) {
  if (!response.headersSent) {
    response.setHeader('Content-type', 'text/html');
    response.write('<!DOCTYPE html>');
  }

  pipe(response);

  if (error) {
    // This error was delayed until the headers were properly sent.
    response.write(getErrorMarkup(error));
  }
}

function writeHeadToServerResponse(
  response: ServerResponse,
  {headers, status, customStatus}: ServerComponentResponse,
  error?: Error
) {
  if (response.headersSent) return;

  headers.forEach((value, key) => response.setHeader(key, value));

  if (error) {
    response.statusCode = 500;
  } else {
    response.statusCode = customStatus?.code ?? status ?? 200;

    if (customStatus?.text) {
      response.statusMessage = customStatus.text;
    }
  }
}

function isRedirect(response: ServerResponse) {
  return response.statusCode >= 300 && response.statusCode < 400;
}
