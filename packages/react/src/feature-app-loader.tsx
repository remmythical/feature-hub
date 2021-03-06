import {
  FeatureAppDefinition,
  FeatureAppEnvironment,
  FeatureServices
} from '@feature-hub/core';
import * as React from 'react';
import {FeatureApp, FeatureAppContainer} from './feature-app-container';
import {
  Css,
  FeatureHubContextConsumer,
  FeatureHubContextConsumerValue
} from './feature-hub-context';
import {prependBaseUrl} from './internal/prepend-base-url';

export interface FeatureAppLoaderProps<TConfig = unknown> {
  /**
   * The Feature App ID is used to identify the Feature App instance. Multiple
   * Feature App Loaders with the same `featureAppId` will render the same
   * Feature app instance. The ID is also used as a consumer ID for dependent
   * Feature Services. To render multiple instances of the same kind of Feature
   * App, different IDs must be used.
   */
  readonly featureAppId: string;

  /**
   * The absolute or relative base URL of the Feature App's assets and/or BFF.
   */
  readonly baseUrl?: string;

  /**
   * The URL of the Feature App's client module bundle. If [[baseUrl]] is
   * specified, it will be prepended, unless `src` is an absolute URL.
   */
  readonly src: string;

  /**
   * The URL of the Feature App's server module bundle. If [[baseUrl]] is
   * specified, it will be prepended, unless `serverSrc` is an absolute URL.
   * Either [[baseUrl]] or `serverSrc` must be an absolute URL.
   */
  readonly serverSrc?: string;

  /**
   * A list of stylesheets to be added to the document. If [[baseUrl]] is
   * specified, it will be prepended, unless [[Css.href]] is an absolute URL.
   */
  readonly css?: Css[];

  /**
   * A config object that is passed to the Feature App's `create` method.
   */
  readonly config?: TConfig;

  /**
   * A callback that is called before the Feature App is created.
   */
  readonly beforeCreate?: (
    env: FeatureAppEnvironment<FeatureServices, TConfig>
  ) => void;

  /**
   * A callback that is passed to the Feature App's `create` method. A
   * short-lived Feature App can call this function when it has completed its
   * task. The Integrator (or parent Feature App) can then decide to e.g.
   * unmount the Feature App.
   */
  readonly done?: () => void;

  readonly onError?: (error: Error) => void;

  readonly renderError?: (error: Error) => React.ReactNode;
}

type InternalFeatureAppLoaderProps<TConfig> = FeatureAppLoaderProps<TConfig> &
  FeatureHubContextConsumerValue;

interface InternalFeatureAppLoaderState {
  readonly featureAppDefinition?: FeatureAppDefinition<unknown>;
  readonly error?: Error;
  readonly failedToHandleAsyncError?: boolean;
}

const inBrowser =
  typeof window === 'object' &&
  typeof document === 'object' &&
  document.nodeType === 9;

class InternalFeatureAppLoader<TConfig = unknown> extends React.PureComponent<
  InternalFeatureAppLoaderProps<TConfig>,
  InternalFeatureAppLoaderState
> {
  public readonly state: InternalFeatureAppLoaderState = {};

  private errorHandled = false;
  private mounted = false;

  public constructor(props: InternalFeatureAppLoaderProps<TConfig>) {
    super(props);

    const {
      baseUrl,
      featureAppManager,
      src: clientSrc,
      serverSrc,
      asyncSsrManager,
      addUrlForHydration,
      addStylesheetsForSsr
    } = props;

    const src = inBrowser ? clientSrc : serverSrc;

    if (!src) {
      if (inBrowser) {
        throw new Error('No src provided.');
      }

      return;
    }

    if (!inBrowser && addUrlForHydration) {
      addUrlForHydration(prependBaseUrl(baseUrl, clientSrc));
    }

    if (!inBrowser && addStylesheetsForSsr) {
      const css = this.prependCssHrefs();

      if (css) {
        addStylesheetsForSsr(css);
      }
    }

    const url = prependBaseUrl(baseUrl, src);

    const {
      error,
      promise: loadingPromise,
      value: featureAppDefinition
    } = featureAppManager.getAsyncFeatureAppDefinition(url);

    if (error) {
      this.handleError(error);

      this.state = {error};
    } else if (featureAppDefinition) {
      this.state = {featureAppDefinition};
    } else if (!inBrowser && asyncSsrManager) {
      asyncSsrManager.scheduleRerender(loadingPromise);
    }
  }

  public async componentDidMount(): Promise<void> {
    this.mounted = true;

    this.appendCss();

    if (this.state.featureAppDefinition) {
      return;
    }

    const {baseUrl, featureAppManager, src} = this.props;

    try {
      const featureAppDefinition = await featureAppManager.getAsyncFeatureAppDefinition(
        prependBaseUrl(baseUrl, src)
      ).promise;

      if (this.mounted) {
        this.setState({featureAppDefinition});
      }
    } catch (error) {
      this.handleAsyncError(error);
    }
  }

  public componentWillUnmount(): void {
    this.mounted = false;
  }

  public render(): React.ReactNode {
    const {
      baseUrl,
      beforeCreate,
      config,
      featureAppId,
      onError,
      renderError,
      done
    } = this.props;

    const {error, failedToHandleAsyncError, featureAppDefinition} = this.state;

    if (error) {
      if (failedToHandleAsyncError) {
        throw error;
      }

      return renderError ? renderError(error) : null;
    }

    if (!featureAppDefinition) {
      // A loading UI could be rendered here.
      return null;
    }

    return (
      <FeatureAppContainer
        baseUrl={baseUrl}
        beforeCreate={beforeCreate}
        config={config}
        featureAppId={featureAppId}
        featureAppDefinition={
          featureAppDefinition as FeatureAppDefinition<FeatureApp>
        }
        onError={onError}
        renderError={renderError}
        done={done}
      />
    );
  }

  private appendCss(): void {
    const css = this.prependCssHrefs();

    if (!css) {
      return;
    }

    for (const {href, media = 'all'} of css) {
      if (!document.querySelector(`link[href="${href}"]`)) {
        document.head.appendChild(
          Object.assign(document.createElement('link'), {
            rel: 'stylesheet',
            href,
            media
          })
        );
      }
    }
  }

  private prependCssHrefs(): Css[] | undefined {
    const {baseUrl, css} = this.props;

    if (!baseUrl || !css) {
      return css;
    }

    return css.map(({href, media}) => ({
      href: prependBaseUrl(baseUrl, href),
      media
    }));
  }

  private handleError(error: Error): void {
    if (this.errorHandled) {
      return;
    }

    this.errorHandled = true;

    if (this.props.onError) {
      this.props.onError(error);
    } else {
      this.logError(error);
    }
  }

  private handleAsyncError(error: Error): void {
    try {
      this.handleError(error);

      if (this.mounted) {
        this.setState({error});
      }
    } catch (handlerError) {
      if (this.mounted) {
        this.setState({error: handlerError, failedToHandleAsyncError: true});
      }
    }
  }

  private logError(error: Error): void {
    const {
      baseUrl,
      featureAppId,
      logger,
      src: clientSrc,
      serverSrc
    } = this.props;

    const src = inBrowser ? clientSrc : serverSrc;

    logger.error(
      `The Feature App for the src ${JSON.stringify(
        src && prependBaseUrl(baseUrl, src)
      )} and the ID ${JSON.stringify(featureAppId)} could not be rendered.`,
      error
    );
  }
}

/**
 * The `FeatureAppLoader` component allows the integrator to load Feature Apps
 * from a remote location. It can also be used by a Feature App to render
 * another Feature App as a child.
 *
 * When a Feature App throws an error while rendering or, in the case of a
 * [[ReactFeatureApp]], throws an error in a lifecycle method, the
 * `FeatureAppLoader` renders `null`. On the server, however, rendering
 * errors are not caught and must therefore be handled by the integrator.
 */
export function FeatureAppLoader<TConfig>(
  props: FeatureAppLoaderProps<TConfig>
): JSX.Element {
  return (
    <FeatureHubContextConsumer>
      {featureHubContextValue => (
        <InternalFeatureAppLoader<TConfig>
          {...featureHubContextValue}
          {...props}
        />
      )}
    </FeatureHubContextConsumer>
  );
}
