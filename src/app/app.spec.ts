import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { App } from './app';

describe('App', () => {
  it('should create the app', () => {
    TestBed.configureTestingModule({ providers: [provideRouter([])] });
    expect(TestBed.createComponent(App).componentInstance).toBeTruthy();
  });
});
