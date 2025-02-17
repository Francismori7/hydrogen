import React from 'react';
import {mount} from '@shopify/react-testing';
import {Helmet} from '../../../client';

import {ImageSeo} from '../ImageSeo.client';

jest.mock('../../../client', () => ({
  Helmet({children}) {
    return children;
  },
}));

describe('<ImageSeo />', () => {
  it('renders nothing in Helmet when no props were provided', () => {
    const wrapper = mount(<ImageSeo />);

    expect(wrapper.find(Helmet).children.length).toBe(0);
  });

  it("renders <meta/> with property='og:image' and content from url prop", () => {
    const wrapper = mount(<ImageSeo url="url-123" />);

    expect(wrapper).toContainReactComponent('meta', {
      property: 'og:image',
      content: 'url-123',
    });
  });

  it("renders <meta/> with property='og:image:secure_url' and content from url prop", () => {
    const wrapper = mount(<ImageSeo url="url-123" />);

    expect(wrapper).toContainReactComponent('meta', {
      property: 'og:image:secure_url',
      content: 'url-123',
    });
  });

  it("renders <meta/> with property='og:image:width' and content from width prop", () => {
    const wrapper = mount(<ImageSeo width={1200} />);

    expect(wrapper).toContainReactComponent('meta', {
      property: 'og:image:width',
      content: '1200',
    });
  });

  it("renders <meta/> with property='og:image:height' and content from height prop", () => {
    const wrapper = mount(<ImageSeo height={600} />);

    expect(wrapper).toContainReactComponent('meta', {
      property: 'og:image:height',
      content: '600',
    });
  });

  it("renders <meta/> with property='og:image:alt' and content from altText prop", () => {
    const wrapper = mount(<ImageSeo altText="alt text" />);

    expect(wrapper).toContainReactComponent('meta', {
      property: 'og:image:alt',
      content: 'alt text',
    });
  });
});
